// This extension's first background script — added specifically because
// chrome.action (the toolbar icon/badge API) isn't exposed to content
// scripts, only to extension pages and the background service worker. Its
// original job was relaying "a job was (or wasn't) detected on this tab"
// into a small badge on the toolbar icon — the passive equivalent of the
// on-page widget, and the *only* signal at all when auto-detect is off (see
// isAutoDetectEnabled() in content/detect.js) and no widget shows on the
// page itself.
//
// chrome.tabs is the same story as chrome.action — not available to content
// scripts, only here — so opening the Dashboard from the page's "log in to
// track this" hint icon also has to relay through this file rather than
// calling chrome.tabs.create directly from the content script.
//
// job-tracker:apiFetch exists for a subtler reason, found live: content
// scripts' fetch() calls do NOT reliably get the same host_permissions-based
// CORS bypass that fetches from extension pages (the popup, the Dashboard)
// do — a content script's network requests run closer to the *page's* own
// origin (de.indeed.com, say) than the extension's, so a fetch straight to
// http://127.0.0.1:8000 from content/detect.js hit a genuine "TypeError:
// Failed to fetch" (a CORS block) even though the exact same call from the
// popup/dashboard works fine. The background service worker is
// unambiguously an extension page for this purpose, so every one of
// content/detect.js's server calls now relays through here instead of
// calling fetch() directly — same pattern as the two relays above, just
// generic enough to carry any path/method/body.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "job-tracker:badge") {
    if (!sender.tab || sender.tab.id == null) return;
    const tabId = sender.tab.id;
    if (message.hasJob) {
      chrome.action.setBadgeText({ tabId, text: "•" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
    }
    return;
  }

  if (message.type === "job-tracker:openDashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dist/browser/index.html") });
    return;
  }

  if (message.type === "job-tracker:apiFetch") {
    const API_BASE = "http://127.0.0.1:8000/api";
    const AUTH_TOKEN_KEY = "authToken";
    (async () => {
      try {
        const stored = await chrome.storage.local.get(AUTH_TOKEN_KEY);
        const token = stored[AUTH_TOKEN_KEY] || null;
        const response = await fetch(`${API_BASE}${message.path}`, {
          ...message.options,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Token ${token}` } : {}),
            ...(message.options && message.options.headers),
          },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 401) await chrome.storage.local.remove(AUTH_TOKEN_KEY);
          sendResponse({ error: data.error || `Server returned ${response.status}` });
          return;
        }
        sendResponse({ data });
      } catch {
        sendResponse({ error: "Couldn't reach the server — make sure it's running (python manage.py runserver)." });
      }
    })();
    return true; // keep the message channel open for the async sendResponse above
  }
});
