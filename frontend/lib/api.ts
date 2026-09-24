/**
 * Browser-side calls to the API. Everything goes to same-origin /api/v1, which Next
 * rewrites to FastAPI, so the httpOnly session cookie rides along automatically.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public field?: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** FastAPI errors come as {detail: string}, {detail: {message, field}} or a validation list. */
function messageFrom(body: unknown, status: number): { message: string; field?: string } {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return { message: detail };
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: string[]; msg?: string } | undefined;
    return {
      message: first?.msg?.replace(/^Value error, /, "") ?? "Please check the form and try again.",
      field: first?.loc?.[first.loc.length - 1],
    };
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    const d = detail as { message: string; field?: string };
    return { message: d.message, field: d.field };
  }
  return { message: `Request failed (${status})` };
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...rest,
      headers: json !== undefined ? { "content-type": "application/json", ...headers } : headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("Can't reach the server. Is the API running?", 0);
  }

  if (res.status === 401 && !path.startsWith("/auth/")) {
    // session expired: back to sign-in, then return here
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
    throw new ApiError("Sign in to continue", 401);
  }
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const { message, field } = messageFrom(body, res.status);
    throw new ApiError(message, res.status, field, body);
  }
  return body as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
