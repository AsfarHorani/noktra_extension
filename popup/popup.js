// Popup dashboard: three tabs — Applications (list/filter/edit/delete),
// Add Manually (fallback form for jobs the content-script detector missed),
// and Insights (Phase 2 — sends everything to the local Django/Ollama
// server and renders back the LLM's patterns). Everything reads/writes
// through storage.js (chrome.storage.local) — this file has no storage
// logic of its own.

import {
  getApplications,
  addApplication,
  updateApplication,
  deleteApplication,
  getApplicationByJobKey,
  getSettings,
  updateSettings,
  getProfile,
  isProfileEmpty,
  apiFetch,
  getAuthToken,
  login,
  logout,
} from "./storage.js";
import { STATUSES } from "../shared/constants.js";

const openDashboardButton = document.getElementById("open-dashboard-button");
const logoutButton = document.getElementById("logout-button");
const autoDetectToggle = document.getElementById("auto-detect-toggle");
const autoDetectHint = document.getElementById("auto-detect-hint");

// --- Auth gate elements ---
// Logging in happens right here (#login-form); signing up always opens the
// Dashboard instead (see popup.html's auth-gate comment).
const authGate = document.getElementById("auth-gate");
const appShell = document.getElementById("app-shell");
const authChoice = document.getElementById("auth-choice");
const showLoginFormButton = document.getElementById("show-login-form-button");
const openDashboardAuthButton = document.getElementById("open-dashboard-auth-button");
const loginForm = document.getElementById("login-form");
const loginEmail = document.getElementById("login-email");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const cancelLoginButton = document.getElementById("cancel-login");

// --- Applications tab elements ---
const tabButtons = document.querySelectorAll(".tab-button");
const tabPanels = document.querySelectorAll(".tab-panel");
const form = document.getElementById("application-form");
const idField = document.getElementById("application-id");
const submitButton = document.getElementById("submit-button");
const cancelEditButton = document.getElementById("cancel-edit");
const statusFilter = document.getElementById("status-filter");
const listContainer = document.getElementById("applications-list");
const emptyState = document.getElementById("empty-state");

// --- Insights tab elements ---
const analyzeButton = document.getElementById("analyze-button");
const insightsStatus = document.getElementById("insights-status");
const insightsResults = document.getElementById("insights-results");
const insightsSummary = document.getElementById("insights-summary");


// Form field ids that map 1:1 to application-record properties — used to
// both read the manual-entry form into an object and to populate it when
// editing an existing record.
const fields = ["jobTitle", "company", "location", "jobUrl", "employmentType", "status", "applicationDate", "notes"];

// Shows one tab-panel and highlights its button; everything else stays
// mounted in the DOM but hidden via the .tab-panel/.active CSS classes.
function switchTab(tabName) {
  tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabName));
  tabPanels.forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
    if (btn.dataset.tab === "list") renderList();
  });
});

// Clears the manual-entry form back to its "new application" state
// (defaults applicationDate to today, since that's the common case).
function resetForm() {
  form.reset();
  idField.value = "";
  submitButton.textContent = "Save Application";
  cancelEditButton.classList.add("hidden");
  document.getElementById("applicationDate").value = new Date().toISOString().slice(0, 10);
}

cancelEditButton.addEventListener("click", resetForm);

// Both "add new" and "edit existing" go through this one submit handler —
// idField.value is empty for a new record, populated (by startEdit) when
// editing, so that alone decides which storage.js call to make.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = {};
  for (const field of fields) {
    data[field] = document.getElementById(field).value.trim();
  }

  const editingId = idField.value;
  if (editingId) {
    await updateApplication(editingId, data);
  } else {
    await addApplication(data);
  }

  resetForm();
  switchTab("list");
  renderList();
});

// Populates the manual-entry form with an existing record's data and
// switches to it, so "Edit" on a list card reuses the same form as
// "Add Manually" instead of needing a separate edit UI.
async function startEdit(app) {
  idField.value = app.id;
  for (const field of fields) {
    document.getElementById(field).value = app[field] || "";
  }
  submitButton.textContent = "Update Application";
  cancelEditButton.classList.remove("hidden");
  switchTab("add");
}

async function handleDelete(id) {
  if (!confirm("Delete this application?")) return;
  await deleteApplication(id);
  renderList();
}

async function handleStatusChange(id, newStatus) {
  await updateApplication(id, { status: newStatus });
  renderList();
}

// Renders however the browser's locale formats a date; falls back to the
// raw string if it isn't parseable rather than showing "Invalid Date".
function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString();
}

// Builds one application card for the list: title/company header, a status
// dropdown that writes straight back to storage on change, meta line
// (location/type/date), notes, and edit/delete actions.
function renderCard(app) {
  const card = document.createElement("div");
  card.className = "app-card";

  const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === app.status ? "selected" : ""}>${s}</option>`).join("");

  card.innerHTML = `
    <div class="app-card-header">
      <div>
        <div class="app-card-title">${escapeHtml(app.jobTitle || "Untitled")}</div>
        <div class="app-card-company">${escapeHtml(app.company || "")}</div>
      </div>
      <span class="status-badge status-${app.status}">${app.status}</span>
    </div>
    <div class="app-card-meta">
      ${[app.location, app.employmentType, formatDate(app.applicationDate)].filter(Boolean).join(" · ")}
      ${app.jobUrl ? `<br><a href="${escapeAttr(app.jobUrl)}" target="_blank" rel="noopener">View posting</a>` : ""}
    </div>
    ${app.notes ? `<div class="app-card-notes">${escapeHtml(app.notes)}</div>` : ""}
    <div class="app-card-actions">
      <select class="status-select">${statusOptions}</select>
      ${app.status === "Pending" ? `<button class="icon-button cover-letter-button">✎ Cover Letter</button>` : ""}
      <button class="icon-button edit-button">Edit</button>
      <button class="icon-button danger delete-button">Delete</button>
    </div>
  `;

  card.querySelector(".status-select").addEventListener("change", (e) => handleStatusChange(app.id, e.target.value));
  card.querySelector(".edit-button").addEventListener("click", () => startEdit(app));
  card.querySelector(".delete-button").addEventListener("click", () => handleDelete(app.id));
  const coverLetterButton = card.querySelector(".cover-letter-button");
  if (coverLetterButton) {
    coverLetterButton.addEventListener("click", () => toggleCoverLetterPanel(card, app));
  }

  return card;
}

// Sends the candidate profile + this job's details to the same Django/Ollama
// assistant endpoint the dashboard's cover-letter-panel uses (see
// assistant-api.ts's generateCoverLetter) — a second, thinner client for the
// same request, since this file is a plain script with no access to that
// TypeScript module. Goes through storage.js's apiFetch so it carries the
// same auth token as every other request this file makes.
async function requestCoverLetter(profile, application, userNotes) {
  const data = await apiFetch("/assistant/cover-letter/", {
    method: "POST",
    body: JSON.stringify({ profile, application, userNotes }),
  });
  return data.coverLetter;
}

// Toggles a compact quick-generate panel under a Pending card: an optional
// notes field, Generate, and — once there's a result — a review-confirm
// checkbox gating Copy. A letter is saved onto the record (app.coverLetter,
// via updateApplication) the moment it's generated, automatically — no
// separate Save click. Re-opening a card that already has a saved letter
// pre-fills the result box with it directly, so opening the panel never
// triggers a fresh generation on its own — clicking Generate/Regenerate is
// the only thing that does that, since running the model again is a real,
// explicit action, not something that should happen just from looking at a
// card twice.
//
// Fetches the profile up front (before building any of the panel's markup)
// so an empty profile shows the "set up your profile" message immediately
// instead of only after a wasted click on Generate — mirrors the server's
// own hard block in assistant/views.py's cover_letter() view, which would
// otherwise be the only thing catching this.
async function toggleCoverLetterPanel(card, app) {
  const existing = card.querySelector(".cover-letter-panel");
  if (existing) {
    existing.remove();
    return;
  }

  // Only one panel open across the whole list at a time — keeps the popup
  // (fixed 340px, limited height) from getting cluttered with several open
  // generation panels at once.
  document.querySelectorAll(".cover-letter-panel").forEach((el) => el.remove());

  const panel = document.createElement("div");
  panel.className = "cover-letter-panel";
  card.appendChild(panel);

  const profile = await getProfile();

  if (isProfileEmpty(profile)) {
    panel.innerHTML = `
      <p class="cover-letter-empty-profile">Your profile is empty, so there's nothing real to write a cover
      letter from. Set up your profile (resume or details) in the Dashboard first, then come back here.</p>
      <button type="button" class="cover-letter-open-dashboard">Set Up Profile</button>
    `;
    panel.querySelector(".cover-letter-open-dashboard").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dist/browser/index.html") });
    });
    return;
  }

  // Never generate without a real job description — user feedback: a
  // letter that doesn't engage with what the specific job asks for isn't
  // worth generating, even as a degraded fallback. Mirrors the server's own
  // hard block in assistant/views.py's cover_letter() (job_description_missing).
  // LinkedIn/d.vinci/generic-fallback jobs don't auto-capture a description
  // (see CLAUDE.md), so this is the normal path there, not an edge case.
  if (!(app.jobDescription || "").trim()) {
    renderJobDescriptionGate(panel, app, profile);
    return;
  }

  renderCoverLetterGenerateForm(panel, app, profile);
}

// Shown in place of the generate form when app.jobDescription is empty —
// paste-and-save first, then falls through to renderCoverLetterGenerateForm
// with the now-populated app. Kept as its own small step (not just an inline
// field on the generate form) so it's unambiguous that nothing can be
// generated until this is resolved, matching "never generate the cover
// letter before it" — there's no generate button visible at all here.
function renderJobDescriptionGate(panel, app, profile) {
  panel.innerHTML = `
    <p class="cover-letter-jd-gate-message">This job doesn't have a description on file yet — paste it in
    first so the letter can actually address what it's asking for.</p>
    <textarea class="cover-letter-jd-input" rows="5" placeholder="Paste the full job description here…"></textarea>
    <p class="cover-letter-error hidden"></p>
    <button type="button" class="cover-letter-jd-save">Save &amp; Continue</button>
  `;
  const errorEl = panel.querySelector(".cover-letter-error");
  const saveButton = panel.querySelector(".cover-letter-jd-save");
  saveButton.addEventListener("click", async () => {
    const text = panel.querySelector(".cover-letter-jd-input").value.trim();
    if (!text) {
      errorEl.textContent = "Paste the job description first.";
      errorEl.classList.remove("hidden");
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    try {
      await updateApplication(app.id, { jobDescription: text });
      app.jobDescription = text;
      renderCoverLetterGenerateForm(panel, app, profile);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
      saveButton.disabled = false;
      saveButton.textContent = "Save & Continue";
    }
  });
}

function renderCoverLetterGenerateForm(panel, app, profile) {
  panel.innerHTML = `
    ${app.coverLetter ? `<p class="cover-letter-saved-hint">Saved ✓ — shown below. Generate again only for a new version.</p>` : ""}
    <textarea class="cover-letter-notes" rows="2" placeholder="Anything to include? (optional)"></textarea>
    <button type="button" class="cover-letter-generate">${app.coverLetter ? "Regenerate" : "Generate"}</button>
    <p class="cover-letter-error hidden"></p>
    <textarea class="cover-letter-result hidden" rows="6" readonly></textarea>
    <p class="cover-letter-ai-warning hidden">⚠️ AI can make mistakes — read this fully and make sure everything
    in it is accurate before you use it.</p>
    <label class="cover-letter-review hidden">
      <input type="checkbox" class="cover-letter-review-checkbox" />
      I've read this and confirm it's accurate
    </label>
    <div class="cover-letter-result-actions hidden">
      <button type="button" class="cover-letter-copy" disabled>Copy</button>
    </div>
  `;

  const generateButton = panel.querySelector(".cover-letter-generate");
  const errorEl = panel.querySelector(".cover-letter-error");
  const resultEl = panel.querySelector(".cover-letter-result");
  const warningEl = panel.querySelector(".cover-letter-ai-warning");
  const reviewLabel = panel.querySelector(".cover-letter-review");
  const reviewCheckbox = panel.querySelector(".cover-letter-review-checkbox");
  const resultActions = panel.querySelector(".cover-letter-result-actions");
  const copyButton = panel.querySelector(".cover-letter-copy");
  const savedHint = panel.querySelector(".cover-letter-saved-hint");

  // A previously-saved letter is treated as already reviewed (the user
  // confirmed it in an earlier session) — only a freshly (re)generated
  // letter in *this* session needs a fresh confirmation, reset below.
  if (app.coverLetter) {
    resultEl.value = app.coverLetter;
    resultEl.classList.remove("hidden");
    warningEl.classList.remove("hidden");
    reviewLabel.classList.remove("hidden");
    resultActions.classList.remove("hidden");
    reviewCheckbox.checked = true;
    copyButton.disabled = false;
  }

  reviewCheckbox.addEventListener("change", () => {
    copyButton.disabled = !reviewCheckbox.checked;
  });

  generateButton.addEventListener("click", async () => {
    generateButton.disabled = true;
    generateButton.textContent = "Generating…";
    errorEl.classList.add("hidden");
    if (savedHint) savedHint.classList.add("hidden");
    reviewCheckbox.checked = false;
    copyButton.disabled = true;
    try {
      const application = {
        jobTitle: app.jobTitle,
        company: app.company,
        location: app.location,
        jobDescription: app.jobDescription,
      };
      const userNotes = panel.querySelector(".cover-letter-notes").value.trim();
      const letter = await requestCoverLetter(profile, application, userNotes);
      resultEl.value = letter;
      resultEl.classList.remove("hidden");
      warningEl.classList.remove("hidden");
      reviewLabel.classList.remove("hidden");
      resultActions.classList.remove("hidden");
      await updateApplication(app.id, { coverLetter: letter });
      app.coverLetter = letter;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    } finally {
      generateButton.disabled = false;
      generateButton.textContent = "Regenerate";
    }
  });

  copyButton.addEventListener("click", async () => {
    if (copyButton.disabled) return;
    await navigator.clipboard.writeText(resultEl.value);
    copyButton.textContent = "Copied ✓";
    setTimeout(() => (copyButton.textContent = "Copy"), 1500);
  });
}

// Every value that ends up in innerHTML below (job titles, company names,
// notes, and — for the Insights tab — LLM-generated text) can ultimately
// come from an untrusted source (a scraped web page, or a locally-run
// model's output), so it's always routed through this before being
// inserted, never concatenated into a template raw.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, "&quot;");
}

// Re-reads the full list from storage and re-renders it, applying the
// current status-filter dropdown selection. Called after every mutation
// (add/edit/delete/status change) rather than patching the DOM in place —
// simple to reason about, and the list is small enough that a full
// re-render is cheap.
async function renderList() {
  const applications = await getApplications();
  const filter = statusFilter.value;
  const filtered = filter ? applications.filter((app) => app.status === filter) : applications;

  listContainer.innerHTML = "";
  emptyState.classList.toggle("hidden", filtered.length > 0);

  for (const app of filtered) {
    listContainer.appendChild(renderCard(app));
  }
}

statusFilter.addEventListener("change", renderList);

// Fills one of the three Insights bullet lists (interview patterns /
// rejection patterns / recommendations) from the array the server returned.
function renderInsightsList(listId, items) {
  const list = document.getElementById(listId);
  list.innerHTML = (items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li class=\"empty\">Nothing notable.</li>";
}

// Shows/hides the small status line above the Insights results
// ("Analyzing…", or an error) — empty string hides it.
function setInsightsStatus(message) {
  insightsStatus.textContent = message;
  insightsStatus.classList.toggle("hidden", !message);
}

// The only place this file talks to the network. Sends every tracked
// application to the local Django server, which computes stats itself and
// asks a local Ollama model for qualitative patterns — see
// server/analysis/views.py for the other half of this request. Fails soft:
// if the server or Ollama isn't running, the catch block shows an inline
// message in the popup instead of an unhandled promise rejection.
analyzeButton.addEventListener("click", async () => {
  const applications = await getApplications();
  if (applications.length === 0) {
    insightsResults.classList.add("hidden");
    setInsightsStatus("No applications tracked yet — nothing to analyze.");
    return;
  }

  analyzeButton.disabled = true;
  insightsResults.classList.add("hidden");
  setInsightsStatus("Analyzing…");

  try {
    const data = await apiFetch("/analyze/", { method: "POST", body: JSON.stringify({ applications }) });

    insightsSummary.textContent = data.insights.summary || "";
    renderInsightsList("insights-interview-patterns", data.insights.interview_patterns);
    renderInsightsList("insights-rejection-patterns", data.insights.rejection_patterns);
    renderInsightsList("insights-recommendations", data.insights.recommendations);

    insightsResults.classList.remove("hidden");
    setInsightsStatus("");
  } catch (err) {
    setInsightsStatus(
      `Couldn't reach the analysis server — make sure it's running (python manage.py runserver) and Ollama is started. (${err.message})`
    );
  } finally {
    analyzeButton.disabled = false;
  }
});

// Opens the Angular dashboard (dashboard/) — a roomier full-tab view with
// full CRUD and a stats flow diagram, built separately (see its own build
// step in dashboard/). It reads the exact same chrome.storage.local
// "applications" key as this popup, not a separate data store.
openDashboardButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dist/browser/index.html") });
});

// Asks the active tab's content script what it detected on the current
// page (see the chrome.runtime.onMessage listener in content/detect.js) and
// pre-fills the Add form with it. Only called when auto-detect is off — see
// initAutoDetectSetting() below — since that's the one case where nothing
// already showed the user this info on the page itself.
async function tryAutoFillFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    const detection = await chrome.tabs.sendMessage(tab.id, { type: "job-tracker:getDetection" });
    if (!detection || !detection.jobData) return; // no content script here, or nothing detected

    // Already tracked? Edit the existing record instead of creating a
    // duplicate — same dedup-by-jobKey the content script itself relies on.
    const existing = detection.jobKey ? await getApplicationByJobKey(detection.jobKey) : null;
    if (existing) {
      startEdit(existing);
      return;
    }

    resetForm();
    const { jobData } = detection;
    document.getElementById("jobTitle").value = jobData.jobTitle || "";
    document.getElementById("company").value = jobData.company || "";
    document.getElementById("location").value = jobData.location || "";
    document.getElementById("jobUrl").value = jobData.jobUrl || "";
    document.getElementById("employmentType").value = jobData.employmentType || "";
    document.getElementById("status").value = "Pending";
    switchTab("add");
  } catch {
    // No content script on this tab (a chrome:// page, the Web Store, a
    // freshly-opened tab that hasn't loaded yet, ...) or messaging failed —
    // leave the popup on its default tab rather than surfacing an error for
    // what's a completely normal case.
  }
}

// Reads the stored auto-detect setting on popup open, reflects it in the
// toggle, and — when it's off — immediately tries to grab whatever's on the
// active tab, since that's the only way the user gets that info now (no
// widget is going to show it to them on the page itself).
async function initAutoDetectSetting() {
  const settings = await getSettings();
  autoDetectToggle.checked = settings.autoDetect;
  autoDetectHint.classList.toggle("hidden", settings.autoDetect);
  if (!settings.autoDetect) {
    await tryAutoFillFromActiveTab();
  }
}

autoDetectToggle.addEventListener("change", async () => {
  await updateSettings({ autoDetect: autoDetectToggle.checked });
  autoDetectHint.classList.toggle("hidden", autoDetectToggle.checked);
});

// --- Auth gate ---
// Every tracked application now lives on the Django server behind a real
// account (see server/accounts/, server/tracker/) — the popup shows nothing
// until a valid token is stored. A real choice between logging in and
// signing up, not an immediate redirect: logging in with an existing
// account happens right here (#login-form); signing up always opens the
// Dashboard instead (see popup.html's auth-gate comment for why).
function showApp() {
  authGate.classList.add("hidden");
  appShell.classList.remove("hidden");
  resetForm();
  renderList();
  initAutoDetectSetting();
}

// Resets back to the "Log In / Sign Up" choice, hiding the login form —
// shown on first load, and again after a failed/cancelled login attempt or
// a logout, so the popup never reopens mid-form with stale input.
function showAuthGate() {
  appShell.classList.add("hidden");
  authGate.classList.remove("hidden");
  authChoice.classList.remove("hidden");
  loginForm.classList.add("hidden");
  loginForm.reset();
  loginError.classList.add("hidden");
}

openDashboardAuthButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dist/browser/index.html") });
});

showLoginFormButton.addEventListener("click", () => {
  authChoice.classList.add("hidden");
  loginForm.classList.remove("hidden");
  loginEmail.focus();
});

cancelLoginButton.addEventListener("click", showAuthGate);

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginSubmit.disabled = true;
  loginError.classList.add("hidden");
  try {
    await login(loginEmail.value.trim(), loginPassword.value);
    showApp();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  } finally {
    loginSubmit.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await logout();
  showAuthGate();
});

// Initial render when the popup opens: show the app if already logged in
// (via either the popup or the Dashboard previously), otherwise the
// login/signup choice.
async function checkAuth() {
  const token = await getAuthToken();
  if (token) {
    showApp();
  } else {
    showAuthGate();
  }
}

checkAuth();
