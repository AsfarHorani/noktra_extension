// Shared authenticated fetch client for applications-service.ts,
// profile-service.ts, auth-service.ts, and assistant-api.ts — every one of
// this dashboard's data calls now goes to the Django server (see
// server/accounts/, server/tracker/) instead of chrome.storage.local
// directly. The one thing still in chrome.storage.local is the auth token
// itself (key "authToken"), same as popup/storage.js's copy of this same
// pattern — duplicated rather than shared across the extension/dashboard
// boundary for the usual reason (dashboard is a separate TS build, popup is
// a plain classic-script module).
const API_BASE = 'http://127.0.0.1:8000/api';
const AUTH_TOKEN_KEY = 'authToken';

export async function getAuthToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(AUTH_TOKEN_KEY);
  return (result[AUTH_TOKEN_KEY] as string) || null;
}

export async function setAuthToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [AUTH_TOKEN_KEY]: token });
}

export async function clearAuthToken(): Promise<void> {
  await chrome.storage.local.remove(AUTH_TOKEN_KEY);
}

// Attaches the token, throws a message-carrying Error on any non-2xx
// response (a 401 also clears the stored token — see auth-service.ts's
// checkAuth, which is what notices and shows the login screen again).
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Token ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Couldn't reach the server — make sure it's running (python manage.py runserver).");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) await clearAuthToken();
    throw new Error((data as { error?: string }).error || `Server returned ${response.status}`);
  }
  return data as T;
}
