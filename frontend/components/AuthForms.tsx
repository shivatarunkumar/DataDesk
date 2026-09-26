"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError, api, errorText } from "@/lib/api";
import { CheckIcon, LogoMark } from "./icons";
import { Alert, Field, inputClass } from "./ui";

type FieldErrors = Partial<Record<string, string>>;

function Shell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div data-ui="auth" className="mx-auto w-full max-w-sm px-4 py-12">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <LogoMark width={44} height={33} />
        <h1 className="text-2xl tracking-tight">{title}</h1>
        <p className="text-sm text-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

const submitClass =
  "mt-2 h-10 rounded-full bg-brand text-sm font-medium text-brand-contrast hover:bg-brand-hover disabled:opacity-60";

/** Where to go after signing in: only same-site paths, never an open redirect. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function LoginForm() {
  const router = useRouter();
  const nextUrl = safeNext(useSearchParams().get("next"));
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!identifier.trim() || !password) {
      setError("Enter your email or username, and your password.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/login", { method: "POST", json: { identifier, password } });
      router.push(nextUrl);
      router.refresh(); // re-render the server layout so the shell shows the account
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Shell title="Sign in to DataDesk" subtitle="Your data files, versioned, and loaded into tables with an admin's approval.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <Field
          label="Email or username"
          value={identifier}
          onChange={setIdentifier}
          autoComplete="username"
          placeholder="you@company.com"
          autoFocus
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <button type="submit" disabled={busy} className={submitClass}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {/* after the button, so Tab goes straight from the email to the password */}
      <p className="mt-4 text-center text-sm">
        <Link href="/forgot-password" className="font-medium text-brand hover:underline">
          Forgot password?
        </Link>
      </p>
      <p className="mt-6 text-center text-sm text-muted">
        New to DataDesk?{" "}
        <Link href="/register" className="font-medium text-brand hover:underline">
          Request an account
        </Link>
      </p>
    </Shell>
  );
}

export function RegisterForm() {
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    username: "",
    email: "",
    requested_role: "user",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setFieldErrors({});
    if (!form.first_name.trim()) return setFieldErrors({ first_name: "Tell us your first name" });
    if (form.password.length < 8) return setFieldErrors({ password: "Use at least 8 characters" });
    if (form.password !== form.confirm) return setFieldErrors({ confirm: "Passwords don't match" });

    setBusy(true);
    try {
      await api("/auth/register", {
        method: "POST",
        json: {
          email: form.email,
          password: form.password,
          first_name: form.first_name,
          last_name: form.last_name || null,
          username: form.username || null,
          requested_role: form.requested_role,
        },
      });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.field) setFieldErrors({ [e.field]: e.message });
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell
        title="Request sent"
        subtitle="An administrator will review your account. You can sign in as soon as it's approved."
      >
        <div className="flex justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok/15 text-ok">
            <CheckIcon />
          </span>
        </div>
        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Request a DataDesk account" subtitle="An administrator approves every new account before it can sign in.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" value={form.first_name} onChange={set("first_name")} autoComplete="given-name" error={fieldErrors.first_name} />
          <Field label="Last name" value={form.last_name} onChange={set("last_name")} autoComplete="family-name" error={fieldErrors.last_name} />
        </div>
        <Field
          label="Email"
          type="email"
          value={form.email}
          onChange={set("email")}
          autoComplete="email"
          placeholder="you@company.com"
          error={fieldErrors.email}
        />
        <Field
          label="Username"
          value={form.username}
          onChange={(v) => set("username")(v.toLowerCase())}
          autoComplete="username"
          hint="Optional. Leave empty to use the part of your email before the @."
          error={fieldErrors.username}
        />
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Account type
          <select
            className={`${inputClass} font-normal`}
            value={form.requested_role}
            onChange={(e) => set("requested_role")(e.target.value)}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <span className="text-xs font-normal text-muted">
            {form.requested_role === "admin"
              ? "Admins approve accounts and loads, and onboard tables. An admin confirms this when approving you."
              : "Keep files, edit them and ask for loads into tables."}
          </span>
        </label>
        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={set("password")}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          error={fieldErrors.password}
        />
        <Field
          label="Confirm password"
          type="password"
          value={form.confirm}
          onChange={set("confirm")}
          autoComplete="new-password"
          error={fieldErrors.confirm}
        />
        <button type="submit" disabled={busy} className={submitClass}>
          {busy ? "Sending…" : "Request account"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </Shell>
  );
}

export function ForgotPasswordForm() {
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = await api<{ message: string }>("/auth/forgot-password", { method: "POST", json: { identifier } });
      setMessage(body.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (message) {
    return (
      <Shell title="Request sent" subtitle={message}>
        <p className="text-center text-sm">
          <Link href="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell
      title="Reset your password"
      subtitle="There's no email reset: an administrator sets a temporary password and gives it to you."
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <Field
          label="Email or username"
          value={identifier}
          onChange={setIdentifier}
          autoComplete="username"
          placeholder="you@company.com"
          autoFocus
        />
        <button type="submit" disabled={busy || !identifier.trim()} className={submitClass}>
          {busy ? "Sending…" : "Ask an admin to reset it"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </Shell>
  );
}
