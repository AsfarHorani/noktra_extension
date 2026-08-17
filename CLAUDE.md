# Job Tracker — Extension

Chrome extension (Manifest V3) + Angular dashboard for the Job Tracker project. See [README.md](README.md) for setup/usage. See [HISTORY.md](HISTORY.md) for the full decision log this repo was split from (predates the split — also covers the Django backend, which now lives in the companion `job-tracker-server` repo).

## What this is

A browser extension that detects job postings on pages you visit, tracks applications, and provides AI-assisted cover letter / interview prep generation. All application/profile data and AI generation is handled by the companion `job-tracker-server` Django API — this repo has no server-side logic of its own beyond `background.js` (a thin relay, see below).

## Architecture conventions

- **No build tooling for `content/`/`popup/`** — plain script tags, ES modules where the classic-script restriction allows it (see below), zero bundler. Keep it that way; don't introduce a build step for these without a real need. `dashboard/` is the one deliberate exception (Angular CLI/TypeScript).
- **`content/detect.js` must stay a classic script, no `import`/`export`.** MV3's static `content_scripts` manifest entry doesn't honor `"type": "module"` — a script using static `import` fails silently. This is why `content/detect.js` inlines its own copies of storage helpers rather than importing `popup/storage.js` or `shared/constants.js`. Keep them in sync by hand if the storage schema changes.
- **Content-script `fetch()` calls are not exempt from CORS** the way extension-page (popup/dashboard) fetches are — confirmed live, not theoretical. `content/detect.js`'s `apiFetch()` relays every server request through `background.js` (`job-tracker:apiFetch` message) instead of calling `fetch()` directly. Don't "simplify" this back to a direct fetch from the content script.
- **`background.js` is a pure relay**, not a policy layer — badge updates, opening the dashboard tab, and the API-fetch relay above. It exists only because `chrome.action`/`chrome.tabs.create`/the CORS bypass aren't available to content scripts. Don't add detection or business logic here.
- **Detection tuning lives in `content/keywords.js`**, not inline in `detect.js` — every keyword/host/phrase list (`NON_JOB_HOSTS`, `NEGATIVE_KEYWORDS`, `APPLY_KEYWORDS`, `SUCCESS_KEYWORDS`, `GENERIC_TITLE_SEPARATORS`, `GENERIC_JOB_PATH_SEGMENTS`, `GENERIC_JOB_CONTEXT_KEYWORDS`, `LISTING_PATH_SEGMENTS`). Expanding these as new false positives/negatives are found is expected routine maintenance — edit that one file.
- **Tracking is opt-in, never passive.** Detecting a job on a page must never by itself persist anything. A record is only created when the user explicitly clicks Save on the widget, or clicks something that looks like an Apply button. Don't regress this to auto-create-on-detect.
- **Server access always goes through the designated client**: `popup/storage.js` (popup), `content/detect.js`'s inlined copy (content script), or `dashboard/src/app/api-client.ts` (dashboard). Never a direct `fetch()` to the backend from anywhere else.
- **Status list and per-status colors are shared constants** — `shared/constants.js` (extension) and `dashboard/src/app/constants.ts`'s `STATUSES`/`STATUS_COLORS` (dashboard, duplicated natively since `allowJs: false` blocks importing the `.js` version). Don't hardcode a status list or a status's color anywhere else; import from these.
- **Dashboard forms are uncontrolled** (template-ref reads on submit, one-way `[value]` bindings for pre-fill), not `[(ngModel)]` — this build has no `zone.js` dependency. Follow this pattern for new forms; profile editing is the one exception (uses signals — genuinely dynamic add/remove lists don't fit the uncontrolled-form pattern well).
- **Generation (cover letter / interview answers) requires both a real profile and a real job description** — hard-blocked client-side (before the request) and server-side (400, before calling the model). `dashboard/src/app/job-description-gate/` is the shared "paste it in first" component both assistant panels use.

## Structure

```
manifest.json              MV3 manifest
background.js               Badge relay, dashboard-open relay, API-fetch relay
content/detect.js           Job detection, jobKey dedup, on-page widget, apply-click tracking
content/keywords.js         Every detection keyword/host/phrase list (loaded before detect.js)
popup/                      Toolbar popup: dashboard summary, manual add, quick cover-letter gen
shared/constants.js         STATUSES, ACTIVE_STATUSES
dashboard/src/app/          Angular dashboard — see below
tests/                      Playwright cross-site detection suite
```

Key `dashboard/src/app/` pieces:
- `app.ts`/`.html`/`.css` — root: sidebar nav, auth gate, cross-cutting state
- `application-board/`, `application-list/` — Jobs page's two views (Kanban board, table)
- `stats-flow/` — Overview page's status breakdown chart
- `cover-letter-panel/`, `interview-answers-panel/`, `job-description-gate/` — AI assistant panels
- `resume-upload/`, `profile-view/` — candidate profile editing
- `applications-service.ts`, `profile-service.ts`, `auth-service.ts`, `api-client.ts` — server CRUD/auth, all going through `api-client.ts`'s `apiFetch`

## Testing

`cd tests && npx playwright test` — the cross-site detection regression suite. Data-driven off `tests/fixtures/*.json`; add a new site by dropping in an html/json fixture pair, no new test code needed. Run this after any change to `content/detect.js` or `content/keywords.js`.

`cd dashboard && npm run build` — no automated dashboard tests yet; a clean build plus manual verification (ideally against a real running backend, or a stubbed `chrome.storage`/`fetch` harness for a quick visual check — see HISTORY.md's "Verification technique" note under the dashboard redesign for the exact pattern) is the current bar.
