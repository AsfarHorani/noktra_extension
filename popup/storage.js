// This module is the entire client for the extension's data. It used to be
// chrome.storage.local directly; now everything (applications, profile,
// settings) lives in the Django server's SQLite database behind real
// signup/login auth (see server/accounts/, server/tracker/) — this file
// just does authenticated fetch()es instead. The one thing that's still
// legitimately in chrome.storage.local is the auth token itself (key
// "authToken"), since that's what makes a request authenticated at all.
// Both the popup and the content script need this logic; the content
// script can't import it directly (see the classic-script note at the top
// of content/detect.js), so it keeps its own inlined copy in sync by hand.

const API_BASE = "http://127.0.0.1:8000/api";
const AUTH_TOKEN_KEY = "authToken";

export async function getAuthToken() {
  const result = await chrome.storage.local.get(AUTH_TOKEN_KEY);
  return result[AUTH_TOKEN_KEY] || null;
}

export async function clearAuthToken() {
  await chrome.storage.local.remove(AUTH_TOKEN_KEY);
}

// Every authenticated call in this file goes through here — attaches the
// token, throws a message-carrying Error on any non-2xx response (including
// a 401 from a missing/expired token, which the popup's top-level init
// treats the same as "never logged in" and shows the login screen again).
// Exported so popup.js can reuse it directly for the two assistant-app
// endpoints it calls outside this file (analyze, cover-letter) instead of
// duplicating the token-attaching/error-shape logic a second time.
export async function apiFetch(path, options = {}) {
  const token = await getAuthToken();
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
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
    throw new Error(data.error || `Server returned ${response.status}`);
  }
  return data;
}

// Logging in (with an existing account) can happen right from the popup —
// only signup() is Dashboard-only (see popup.html's auth-gate comment):
// creating a new account has more steps/validation, but typing an email/
// password you already have shouldn't require leaving the popup for a
// whole new tab.
export async function login(email, password) {
  const data = await apiFetch("/auth/login/", { method: "POST", body: JSON.stringify({ email, password }) });
  await chrome.storage.local.set({ [AUTH_TOKEN_KEY]: data.token });
  return data;
}

export async function logout() {
  try {
    await apiFetch("/auth/logout/", { method: "POST" });
  } catch {
    // Swallowed deliberately, not just cleaned up in `finally` — a
    // try/finally with no catch still re-throws after finally runs, which
    // would leave a failed server call (e.g. server not running) as an
    // unhandled rejection in popup.js's logout button handler, which has
    // no catch of its own and would never reach its showAuthGate() call as
    // a result — the popup would stay stuck showing the now-invalid app
    // shell instead of returning to the login screen. Clearing locally
    // regardless of whether the server call succeeded is the whole point
    // here (see below); the caller doesn't need to know it failed.
  } finally {
    await clearAuthToken();
  }
}

export async function getApplications() {
  return apiFetch("/applications/");
}

export async function addApplication(data) {
  return apiFetch("/applications/", { method: "POST", body: JSON.stringify(data) });
}

export async function updateApplication(id, updates) {
  return apiFetch(`/applications/${id}/`, { method: "PATCH", body: JSON.stringify(updates) });
}

// jobKey (hostname:identifier, or hostname+pathname as a fallback — see
// content/detect.js) is how the content script dedupes the same posting
// across revisits, so it can tell "already tracked, show a status prompt"
// apart from "never seen, show a track prompt".
export async function getApplicationByJobKey(jobKey) {
  return apiFetch(`/applications/by-key/?jobKey=${encodeURIComponent(jobKey)}`);
}

export async function deleteApplication(id) {
  return apiFetch(`/applications/${id}/`, { method: "DELETE" });
}

// Wipes every tracked application. Irreversible — callers (the dashboard's
// "Clear All" button) are expected to confirm with the user before calling
// this, the same way deleteApplication's callers already do for a single
// record.
export async function clearApplications() {
  return apiFetch("/applications/clear/", { method: "DELETE" });
}

// Server default (autoDetect: true) matches what a freshly-signed-up user
// gets from server/tracker/models.py's UserSettings — no local default
// merge needed anymore, the server already returns a fully-formed object.
export async function getSettings() {
  return apiFetch("/settings/");
}

export async function updateSettings(updates) {
  return apiFetch("/settings/", { method: "PUT", body: JSON.stringify(updates) });
}

// Read-only access to the candidate profile the dashboard's Profile page
// builds. Editing it stays dashboard-only (structured experience/
// education/etc. AI extraction, dynamic add/remove lists) — this is just
// enough for the popup's quick-generate Cover Letter action to hand a
// profile to the same /api/assistant/cover-letter/ endpoint the dashboard
// uses. Returns {} (not null) when nothing's been set up yet — see
// isProfileEmpty() below for what happens in that case now.
export async function getProfile() {
  try {
    return await apiFetch("/profile/");
  } catch {
    return {};
  }
}

// Mirrors server/assistant/prompts.py's profile_is_empty() and the
// dashboard's profile-service.ts's isProfileEmpty() — kept in sync by hand
// across all three, same as every other client/server duplication in this
// project. The server now rejects cover-letter generation outright on an
// empty profile (see CLAUDE.md's Assistant section: a letter with nothing
// real to draw on is worse than no letter, not an acceptable degraded case)
// — this lets the popup show that message immediately, before ever calling
// the endpoint, same as the dashboard does.
export function isProfileEmpty(profile) {
  if (!profile) return true;
  return !(
    profile.summary ||
    profile.resumeText ||
    (profile.experience && profile.experience.length) ||
    (profile.education && profile.education.length) ||
    (profile.projects && profile.projects.length) ||
    (profile.skills && profile.skills.length) ||
    (profile.languages && profile.languages.length) ||
    (profile.certifications && profile.certifications.length) ||
    (profile.interests && profile.interests.length)
  );
}
