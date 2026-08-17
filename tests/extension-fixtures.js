// Loads the *real* unpacked extension into a real (non-headless) Chromium
// profile, via Playwright's documented pattern for MV3 extension testing —
// chromium.launchPersistentContext with --load-extension. This is the whole
// point of using Playwright here instead of re-testing the detection logic
// in isolation: a passing test means content/detect.js, as actually
// shipped, produced the right widget on a real page.
//
// headless: false is required — MV3 extensions (background service worker)
// don't reliably load under Playwright's classic headless mode. Chrome's
// newer "headless=new" mode does support extensions in recent versions, but
// isn't used here to keep this the documented-reliable path; CI runners
// need a virtual display (e.g. xvfb-run) to run a non-headless browser.
//
// Each test gets its own fresh, temporary profile directory — deliberately
// not shared across tests — so one fixture's chrome.storage.local state
// (e.g. a record saved while a test interacts with the widget) can never
// leak into another fixture's detection result.
const os = require("os");
const path = require("path");
const fs = require("fs");
const { test: base, chromium } = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, ".."); // repo root — where manifest.json lives

const test = base.extend({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-tracker-pw-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
});

// Detection now requires a logged-in session (see CLAUDE.md's "Real
// Backend" section) — content/detect.js checks chrome.storage.local's
// authToken before showing any track/status widget at all. chrome.storage
// isn't reachable from a plain page context (regular web pages, and even
// Playwright's page.addInitScript, don't get the extension's chrome.*
// bindings), so this seeds it via the extension's own background service
// worker instead, which shares the same storage area as content/detect.js.
// Fixture tests care about detection logic, not the login flow itself, so
// a fake token is enough — the actual API calls it gates are mocked
// separately in detection.spec.js's route handler.
async function seedAuthToken(context, token = "playwright-test-token") {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent("serviceworker");
  }
  await worker.evaluate((t) => chrome.storage.local.set({ authToken: t }), token);
}

module.exports = { test, expect: base.expect, seedAuthToken };
