const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8001';

// ── Auth ──────────────────────────────────────────────────────────────────────

async function authFetch(path: string, options: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) {
    if (res.status === 401) {
      // Token expired — clear storage and reload to force re-login
      try {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
      } catch {}
      window.location.reload();
    }
    const detail = Array.isArray(data.detail)
      ? data.detail.map((e: any) => e.msg ?? JSON.stringify(e)).join(', ')
      : data.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed: ${res.status}`);
  }
  return data;
}

export async function registerUser(
  email: string,
  password: string,
  first_name?: string,
  last_name?: string,
  username?: string,
) {
  return authFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, first_name, last_name, username }),
  });
}

export async function loginUser(identifier: string, password: string) {
  return authFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
}

export async function getPendingUsers(token: string) {
  return authFetch('/admin/users/pending', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function approveUser(token: string, userId: string) {
  return authFetch(`/admin/users/${userId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function rejectUser(token: string, userId: string) {
  return authFetch(`/admin/users/${userId}/reject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Password resets ───────────────────────────────────────────────────────────

export async function forgotPassword(identifier: string) {
  return authFetch('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ identifier }),
  });
}

export async function getAdminPasswordResets(token: string) {
  return authFetch('/admin/password-resets', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function resolvePasswordReset(token: string, resetId: string, newPassword: string) {
  return authFetch(`/admin/password-resets/${resetId}/resolve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ new_password: newPassword }),
  });
}

// ── Data Workspace ─────────────────────────────────────────────────────────────

const WS_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8001';

// authFetch forces JSON Content-Type; uploads need multipart, so use a
// dedicated helper that lets the browser set the boundary itself.
async function authUpload(path: string, token: string, form: FormData) {
  const res = await fetch(`${WS_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({ detail: res.statusText }));
  if (!res.ok) {
    if (res.status === 401) {
      try {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
      } catch {}
      window.location.reload();
    }
    const detail = Array.isArray(data.detail)
      ? data.detail.map((e: any) => e.msg ?? JSON.stringify(e)).join(', ')
      : data.detail;
    throw new Error(typeof detail === 'string' ? detail : `Upload failed: ${res.status}`);
  }
  return data;
}

export async function uploadWorkspaceFile(token: string, file: File, folderId?: string | null) {
  const form = new FormData();
  form.append('file', file);
  if (folderId) form.append('folder_id', folderId);
  return authUpload('/workspace/files', token, form);
}

export async function listFolders(token: string) {
  return authFetch('/workspace/folders', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createFolder(token: string, name: string, parentId?: string | null) {
  return authFetch('/workspace/folders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, parent_id: parentId ?? null }),
  });
}

export async function deleteFolder(token: string, folderId: string) {
  return authFetch(`/workspace/folders/${folderId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function listWorkspaceFiles(token: string) {
  return authFetch('/workspace/files', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getFileVersions(token: string, fileId: string) {
  return authFetch(`/workspace/files/${fileId}/versions`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getFileContent(
  token: string,
  fileId: string,
  version?: number,
  delimiter?: string,
) {
  const params = new URLSearchParams();
  if (version != null) params.set('version', String(version));
  if (delimiter) params.set('delimiter', delimiter);
  const qs = params.toString();
  return authFetch(`/workspace/files/${fileId}/content${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function saveFileContent(
  token: string,
  fileId: string,
  columns: string[],
  rows: any[],
  note?: string,
  delimiter?: string,
) {
  return authFetch(`/workspace/files/${fileId}/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ columns, rows, note, delimiter }),
  });
}

export async function updateWorkspaceFile(
  token: string,
  fileId: string,
  patch: { original_name?: string; is_permanent?: boolean },
) {
  return authFetch(`/workspace/files/${fileId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
}

export async function deleteWorkspaceFile(token: string, fileId: string) {
  return authFetch(`/workspace/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function downloadWorkspaceFileUrl(fileId: string) {
  return `${WS_BASE}/workspace/files/${fileId}/download`;
}

export async function getUploadTargets(token: string) {
  return authFetch('/workspace/targets', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function submitUploadRequest(
  token: string,
  payload: {
    file_id: string;
    target_type: string;
    database?: string | null;
    schema_name?: string | null;
    table: string;
    write_mode: string;
    key_columns?: string[] | null;
    justification?: string | null;
  },
) {
  return authFetch('/workspace/upload-requests', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getMyUploadRequests(token: string) {
  return authFetch('/workspace/upload-requests', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Admin: upload approvals ─────────────────────────────────────────────────────

export async function getAdminUploadRequests(token: string) {
  return authFetch('/admin/upload-requests', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getAdminUploadHistory(token: string) {
  return authFetch('/admin/upload-requests/history', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function approveUploadRequest(token: string, requestId: string) {
  return authFetch(`/admin/upload-requests/${requestId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function rejectUploadRequest(token: string, requestId: string, reviewNote?: string) {
  return authFetch(`/admin/upload-requests/${requestId}/reject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ review_note: reviewNote ?? null }),
  });
}
