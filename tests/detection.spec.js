// Data-driven: one test per fixtures/*.json file, run against the real
// extension (see extension-fixtures.js). Adding site #21 later means
// dropping in a new fixtures/<name>.html + fixtures/<name>.json pair, not
// writing new test code.
//
// Fixtures are served via request interception, not a local static server
// at 127.0.0.1 — detectJob()'s host-gated logic (extractIndeedFallback,
// extractLinkedInFallback, extractDvinciFallback, NON_JOB_HOSTS,
// LISTING_PATH_SEGMENTS, LinkedIn's /jobs/ path check — see
// content/detect.js) all read `location.hostname`/`location.pathname`.
// Navigating to a fixture served from 127.0.0.1 would make every one of
// those checks see the wrong host and silently behave as if on an
// unrecognized site, regardless of what HTML was served. Instead, each
// test navigates to the fixture's *real* recorded URL and Playwright's
// route interception fulfills that exact request with the saved local
// HTML — the page never actually leaves the machine, but `location.href`
// is genuinely correct, because that's really what was navigated to.
const fs = require("fs");
const path = require("path");
const { test, expect, seedAuthToken } = require("./extension-fixtures");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

// waitForDetection() in content/detect.js retries for up to ~6s (6 attempts
// x 1000ms) before giving up — a negative-case assertion has to outlast
// that, or an absence could just mean "hadn't finished retrying yet," not
// "correctly detected nothing."
const DETECTION_RETRY_WINDOW_MS = 6000;
const WAIT_MARGIN_MS = 2000;

const cases = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"));
    return { name: f.replace(/\.json$/, ""), ...meta };
  });

test.describe("cross-site job detection", () => {
  for (const fixture of cases) {
    test(`${fixture.name}${fixture.expectDetected ? "" : " (should NOT detect)"}`, async ({ context }) => {
      const html = fs.readFileSync(path.join(FIXTURES_DIR, `${fixture.name}.html`), "utf8");

      // Every widget/status prompt is now gated on a logged-in session
      // (see CLAUDE.md's "Real Backend" section) — without this, detection
      // still runs, but content/detect.js shows a "log in via the popup"
      // hint instead of the actual track prompt these tests assert on.
      await seedAuthToken(context);

      // Only the fixture's own document request, and the two API calls
      // scan() now makes (dedup lookup, auto-detect setting — both
      // authenticated fetch()es to the Django server, see content/detect.js),
      // are intercepted with a real response; everything else (subresource
      // fetches the page's own JS might still try — images, further
      // scripts) is aborted. Detection only ever reads what's already in
      // the DOM/JSON-LD at document_idle, so the page doesn't need its own
      // subresources to succeed for our purposes — these fixtures were
      // saved post-render for sites that needed it (see capture-fixture.js),
      // so the DOM is already in its final shape. No real Django server
      // runs during these tests — mocking these two calls keeps the suite
      // self-contained and fast, and matches what the by-key lookup always
      // returns for a job that's never been tracked before (null).
      // Captures the body of a POST to /api/applications/ if the test below
      // clicks Save (only fixtures with expectedJobDescriptionSubstring do) —
      // this is what actually caught the "jobDescription silently dropped on
      // save" bug, which no earlier version of this suite exercised at all
      // (the suite only ever read the pre-filled form, never clicked Save).
      let savedPayload = null;
      await context.route("**/*", (route) => {
        const request = route.request();
        const url = request.url();
        if (url === fixture.url) {
          route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        } else if (url.includes("/api/applications/by-key/")) {
          route.fulfill({ status: 200, contentType: "application/json", body: "null" });
        } else if (url.includes("/api/settings/")) {
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ autoDetect: true }) });
        } else if (request.method() === "POST" && url.endsWith("/api/applications/")) {
          savedPayload = request.postDataJSON();
          route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: 1, ...savedPayload }) });
        } else {
          route.abort();
        }
      });

      const page = await context.newPage();
      await page.goto(fixture.url);

      const widgetHost = page.locator("#job-tracker-widget-host");
      const hintHost = page.locator("#job-tracker-hint-host");

      if (fixture.expectDetected) {
        await expect(widgetHost).toBeAttached({ timeout: DETECTION_RETRY_WINDOW_MS + WAIT_MARGIN_MS });

        // Fallback-sourced sites show the "Are you applying here?"
        // confirm-prompt first (auto mode) — click through to reveal the
        // full form before reading the title. jsonld-sourced sites skip
        // straight to the form, so this is a no-op there.
        const yesButton = widgetHost.locator('[data-action="yes"]');
        if (await yesButton.count()) {
          await yesButton.click();
        }

        const jobTitleInput = widgetHost.locator('[data-field="jobTitle"]');
        await expect(jobTitleInput).toBeVisible();
        const actualTitle = (await jobTitleInput.inputValue()).toLowerCase();

        if (fixture.expectedJobTitle) {
          expect(actualTitle).toContain(fixture.expectedJobTitle.toLowerCase());
        }
        if (fixture.expectedCompany) {
          const actualCompany = (await widgetHost.locator('[data-field="company"]').inputValue()).toLowerCase();
          expect(actualCompany).toContain(fixture.expectedCompany.toLowerCase());
        }

        // Regression coverage for a real bug: extractIndeedFallback() (and
        // renderTrackPrompt's Save handler more generally) used to silently
        // drop jobDescription even when it had genuinely been scraped from
        // the page — there's no field for it on this compact widget, so
        // nothing here surfaced the loss until a generated cover letter
        // came out generic. Clicking Save and inspecting the actual POST
        // body is the only way to catch that class of bug — reading the
        // pre-filled form fields above wouldn't have.
        if (fixture.expectedJobDescriptionSubstring) {
          await widgetHost.locator('[data-action="save"]').click();
          await expect.poll(() => savedPayload).not.toBeNull();
          expect((savedPayload.jobDescription || "").toLowerCase()).toContain(
            fixture.expectedJobDescriptionSubstring.toLowerCase()
          );
        }
      } else {
        await page.waitForTimeout(DETECTION_RETRY_WINDOW_MS + WAIT_MARGIN_MS);
        await expect(widgetHost).not.toBeAttached();
        await expect(hintHost).not.toBeAttached();
      }
    });
  }
});
