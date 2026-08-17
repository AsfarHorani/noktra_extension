# Job Tracker — Extension

A Chrome extension that automatically detects job postings as you browse, tracks your applications, and uses a locally-run AI model to generate tailored cover letters, interview prep answers, and job-search insights.

This repo is the client half of a two-repo project. The Django API it talks to lives in a companion repo: **[noktra_server](https://github.com/AsfarHorani/noktra_server)** — you'll need it running for anything in this extension to work.

## Features

- **Automatic job detection** — scans pages you visit for `schema.org/JobPosting` structured data (with dedicated fallbacks for Indeed, LinkedIn, and d.vinci-powered career sites, which don't expose it), and asks a single yes/no question via a small on-page widget before tracking anything. Never auto-tracks silently.
- **Kanban board & list views** — a Huntr-style drag-and-drop board (default) or a dense sortable table, your choice, in the full-tab dashboard.
- **AI cover letters & interview prep** — generated from your real candidate profile (parsed from an uploaded resume) and a specific job's actual description, by a model running entirely on your machine via [Ollama](https://ollama.com). Blocked outright (with a clear message) if either the profile or the job description is missing, rather than producing a generic, unhelpful result.
- **AI-generated job-search insights** — compares the applications that led to an interview/offer against the ones that were rejected/ghosted and surfaces qualitative patterns.
- **Real accounts** — applications, profile, and settings are stored server-side behind a real signup/login, not just in browser storage.

## How it's put together

```
manifest.json     Chrome Extension Manifest V3
background.js     Service worker — badge updates, opening the dashboard, relaying API calls
content/          Job-detection logic + the on-page tracking widget (runs on every http(s) page)
popup/            Toolbar popup — quick dashboard, manual add, quick cover-letter generation
shared/           Constants shared between content/ and popup/
dashboard/        Angular app — the full-tab dashboard (kanban board, list, profile, AI panels)
tests/            Playwright suite — loads the real unpacked extension against ~16 saved site fixtures
```

`content/` and `popup/` are plain, buildless ES modules/classic scripts — no bundler, loaded directly by Chrome. `dashboard/` is the one part of this repo with a real build step (Angular CLI); it's compiled and the output is loaded by the extension at runtime via `chrome.tabs.create`.

## Getting started

### Prerequisites

- Google Chrome (or another Chromium-based browser — untested but should work unmodified)
- Node.js 20+ (for building the dashboard and running tests)
- The [noktra_server](https://github.com/AsfarHorani/noktra_server) API running locally, with [Ollama](https://ollama.com) available for the AI features

### Build the dashboard

```bash
cd dashboard
npm install
npm run build
```

This has to be re-run after any change under `dashboard/src/**` — Chrome loads the compiled output directly from disk, there's no dev server involved in the actual extension.

### Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this repo's root directory
4. Make sure [noktra_server](https://github.com/AsfarHorani/noktra_server) is running (`python manage.py runserver 8000`), then click the extension icon and sign up

### Development loop

- Editing `content/`, `popup/`, `background.js`, or `manifest.json`: reload the extension from `chrome://extensions`, then refresh any already-open tabs (a tab open before a reload has a stale, "context invalidated" content script — this is expected, not a bug).
- Editing `dashboard/src/**`: re-run `npm run build`, then reopen the dashboard tab (or reload the extension first if it's your first build).

## Testing

Automated cross-site detection regression suite (Playwright, loads the real unpacked extension):

```bash
cd tests
npm install
npx playwright install chromium
npx playwright test               # full suite
npx playwright test -g "<name>"   # one fixture
```

~16 fixtures covering real job-posting structures (JSON-LD, Indeed/LinkedIn/d.vinci fallbacks, generic-site fallback) and known false-positive regressions (YouTube, Reddit, Wikipedia, a LinkedIn profile page, a search-results listing page). Fixtures are frozen HTML snapshots served via request interception — nothing here makes live requests to the real sites at test time (the one LinkedIn fixture was captured via a single manual visit, never re-scraped).

No automated tests for the dashboard itself (Angular) yet — verified manually against a running backend.

## Configuration

The backend URL is currently hardcoded to `http://127.0.0.1:8000/api` in three places (each client context needs its own copy — see [CLAUDE.md](CLAUDE.md) for why they can't share one module):

- `popup/storage.js`
- `content/detect.js`
- `dashboard/src/app/api-client.ts`

If you're pointing at a server running somewhere other than `127.0.0.1:8000`, update the `API_BASE` constant in all three files.

## Permissions

This extension requests `http://*/*` and `https://*/*` — Chrome will show a broad "read and change all your data on all websites" warning on install. This is inherent to scanning arbitrary career sites for job-posting data, not scope creep; the content script only ever reads page structure to detect a job posting, and only ever persists something when you explicitly confirm it.
