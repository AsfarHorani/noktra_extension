// NOTE: this file intentionally does not use ES `import`/`export`. Static
// module imports are not supported for content scripts declared in the
// manifest's `content_scripts` list (only for a separate dynamic-registration
// API), so this must be a plain classic script. The small amount of storage
// logic it needs is inlined below rather than shared with popup/storage.js —
// keep the two in sync manually if the storage schema changes.
(function () {
  const ACTIVE_STATUSES = ["Applied", "Interview"];
  // Offered on the track-prompt widget's status dropdown (see
  // renderTrackPrompt) — the full shared/constants.js STATUSES list minus
  // "Ignored", which stays a popup-only manual status by design (see
  // CLAUDE.md: it's "no longer reachable from the page flow"). Keep this in
  // sync with shared/constants.js by hand — same classic-script import
  // restriction as ACTIVE_STATUSES above.
  const TRACK_STATUSES = ["Pending", "Applied", "Interview", "Offer", "Rejected", "Withdrawn", "Ghosted"];

  // Applications/profile/settings now live on the Django server (see
  // server/accounts/, server/tracker/), not chrome.storage.local — the one
  // thing still stored locally is the auth token itself, since that's what
  // makes a request authenticated at all.
  const AUTH_TOKEN_KEY = "authToken";

  async function getAuthToken() {
    const result = await chrome.storage.local.get(AUTH_TOKEN_KEY);
    return result[AUTH_TOKEN_KEY] || null;
  }

  // Confirmed live: a content script's own fetch() to 127.0.0.1:8000 gets
  // blocked with a plain "TypeError: Failed to fetch" — host_permissions'
  // CORS bypass reliably covers extension pages (the popup, the Dashboard;
  // see popup/storage.js's apiFetch and dashboard/src/app/api-client.ts)
  // but not content-script fetches, which run closer to the *page's* own
  // origin than the extension's. So this relays through background.js's
  // job-tracker:apiFetch handler (an unambiguous extension page) instead of
  // calling fetch() directly — see the comment at the top of background.js.
  async function apiFetch(path, options = {}) {
    const result = await chrome.runtime.sendMessage({ type: "job-tracker:apiFetch", path, options });
    if (!result) throw new Error("Couldn't reach the server — make sure it's running (python manage.py runserver).");
    if (result.error) throw new Error(result.error);
    return result.data;
  }

  // Logging in (not signing up — see the not-logged-in hint icon below for
  // why that distinction matters) can happen right here on the page,
  // without leaving for the Dashboard — this is the one write call in this
  // file that's legitimately unauthenticated (apiFetch's Authorization
  // header is just absent/ignored server-side for this endpoint).
  async function login(email, password) {
    const data = await apiFetch("/auth/login/", { method: "POST", body: JSON.stringify({ email, password }) });
    await chrome.storage.local.set({ [AUTH_TOKEN_KEY]: data.token });
    return data;
  }

  // When autoDetect is false, detection below still runs (currentDetection
  // is kept up to date so the popup's manual "grab info from this page"
  // flow — see the chrome.runtime.onMessage listener near the bottom — has
  // something to return), but nothing is shown or auto-created on this page
  // without the user explicitly opening the popup for it. Not logged in is
  // treated the same as "off" here — there's nothing to auto-create against
  // without a session.
  async function isAutoDetectEnabled() {
    try {
      const settings = await apiFetch("/settings/");
      return settings.autoDetect !== false;
    } catch {
      return false;
    }
  }

  async function getApplications() {
    return apiFetch("/applications/");
  }

  async function addApplication(data) {
    return apiFetch("/applications/", { method: "POST", body: JSON.stringify(data) });
  }

  async function updateApplication(id, updates) {
    return apiFetch(`/applications/${id}/`, { method: "PATCH", body: JSON.stringify(updates) });
  }

  async function getApplicationByJobKey(jobKey) {
    return apiFetch(`/applications/by-key/?jobKey=${encodeURIComponent(jobKey)}`);
  }

  async function deleteApplication(id) {
    return apiFetch(`/applications/${id}/`, { method: "DELETE" });
  }

  // Reloading/updating the extension orphans any content script already
  // injected into an open tab: its chrome.* API bindings die, and every
  // subsequent chrome.storage call throws this specific error. There's
  // nothing this script can do about it — only a page refresh re-injects a
  // live content script — so entry points below catch it and stop quietly
  // instead of surfacing an unhandled promise rejection in the page console.
  function isContextInvalidated(err) {
    return err instanceof Error && /Extension context invalidated/.test(err.message);
  }

  // Relays a "job (not) detected on this tab" signal to background.js,
  // which sets a small badge on the toolbar icon — see background.js for
  // why this can't just be done directly from here (chrome.action isn't
  // exposed to content scripts). Sent regardless of the auto-detect setting
  // — it's the *only* signal at all once that's off and no widget shows.
  // Fire-and-forget: a missing/not-yet-woken background script isn't worth
  // failing the whole scan over, so failures here are swallowed silently
  // rather than routed through isContextInvalidated()'s rethrow.
  function notifyBadge(hasJob) {
    try {
      chrome.runtime.sendMessage({ type: "job-tracker:badge", hasJob }).catch(() => {});
    } catch {
      // Extension context invalidated, or no listener yet — nothing to do.
    }
  }

  // Scans every <script type="application/ld+json"> block on the page for a
  // schema.org JobPosting object — the primary, most reliable detection
  // path; only tried after this do the site-specific/generic fallbacks run.
  function extractJobPosting() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const candidates = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const item of candidates) {
        const type = item && item["@type"];
        const isJobPosting = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        if (isJobPosting) return item;
      }
    }
    return null;
  }

  // JobPosting's jobLocation can be a single object, an array (multi-site
  // postings), or absent with jobLocationType: "TELECOMMUTE" for remote —
  // this collapses all three shapes into one display string.
  function normalizeLocation(job) {
    if (job.jobLocationType === "TELECOMMUTE" && !job.jobLocation) return "Remote";
    const loc = Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation;
    const address = loc && loc.address;
    if (!address) return "";
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean);
    return parts.join(", ");
  }

  // employmentType is schema.org enum-cased ("FULL_TIME") or an array of
  // those; convert to the "Full Time" style used in the popup's dropdown.
  function normalizeEmploymentType(type) {
    if (!type) return "";
    const value = Array.isArray(type) ? type[0] : type;
    return String(value)
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Prefers JobPosting's own `identifier` (stable across revisits, even if
  // the URL changes) and only falls back to hostname+pathname when a
  // posting doesn't provide one.
  function computeJobKey(job, pageUrl) {
    const identifier = job.identifier && (job.identifier.value || job.identifier);
    if (identifier) return `${location.hostname}:${identifier}`;
    const url = new URL(pageUrl);
    return `${url.hostname}${url.pathname}`;
  }

  // JobPosting's `description` is schema.org-legal HTML (confirmed on
  // schwarz-digits.de: "<br><br><h3>...</h3><div><p>...</p></div>..."), but
  // it's only ever used as plain-text LLM prompt input (see the dashboard's
  // cover-letter/interview-answer generation) or an editable textarea value
  // — never rendered as HTML anywhere. Deliberately a plain tag-stripping
  // regex, not `div.innerHTML = raw; div.textContent`: assigning HTML into
  // even a detached, never-appended element can still trigger side effects
  // (an <img> tag begins its network request once parsed into a node, even
  // an unattached one, in some browsers) — a regex strip never lets the
  // browser interpret the markup as real HTML at all. Trade-off: leaves
  // HTML entities (`&amp;`, `&nbsp;`) undecoded — cosmetic only, harmless
  // as LLM input.
  function stripHtml(html) {
    return html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Maps a raw schema.org JobPosting object onto this extension's own
  // (smaller, flatter) job-data shape — the same shape every fallback below
  // also produces, so detectJob()'s caller never needs to know which path
  // a given result came from. jobDescription is JSON-LD-only — none of the
  // fallbacks below (Indeed/LinkedIn/d.vinci/generic) have a reliably
  // structured description to read, so it's left for the user to paste
  // manually in the dashboard there instead.
  function normalizeJob(raw, pageUrl) {
    return {
      jobTitle: raw.title || "",
      company: (raw.hiringOrganization && raw.hiringOrganization.name) || "",
      location: normalizeLocation(raw),
      employmentType: normalizeEmploymentType(raw.employmentType),
      jobDescription: raw.description ? stripHtml(String(raw.description)) : "",
      jobUrl: pageUrl,
    };
  }

  // Indeed exposes no schema.org JobPosting data anywhere (confirmed by
  // inspecting the search/listing page, the apply flow, and the post-apply
  // confirmation page — all empty). It does use stable data-testid
  // attributes on the job detail panel though, so fall back to reading
  // those directly when the generic JSON-LD extraction finds nothing.
  // Fragile by nature: if Indeed renames these testids, this silently stops
  // working until updated.
  function extractIndeedFallback(pageUrl) {
    if (!location.hostname.includes("indeed.")) return null;

    const titleEl = document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]');
    if (!titleEl || !titleEl.textContent.trim()) return null;

    const companyEl = document.querySelector('[data-testid="inlineHeader-companyName"]');
    const locationEl =
      document.querySelector('[data-testid="inlineHeader-companyLocation"]') ||
      document.querySelector('[data-testid="jobsearch-JobInfoHeader-companyLocation"]');
    // Confirmed live on a real posting (de.indeed.com): unlike the header
    // fields above, the full description text does render in the DOM under
    // this id — Indeed just doesn't expose it as JobPosting JSON-LD. Without
    // this, jobDescription stays permanently empty for every Indeed-sourced
    // record, which silently degraded cover-letter generation to a generic
    // "no job description was captured" fallback (see
    // build_cover_letter_prompt's no_jd_note in server/assistant/prompts.py)
    // even though the actual requirements were sitting right there on the
    // page the whole time. .innerText (not .textContent) to keep the
    // paragraph breaks Indeed renders, same reasoning normalizeJob's
    // stripHtml() applies to JSON-LD descriptions elsewhere in this file.
    const descriptionEl = document.querySelector("#jobDescriptionText");

    const url = new URL(pageUrl);
    const jobId = url.searchParams.get("vjk") || url.searchParams.get("jk");
    const jobKey = jobId ? `${url.hostname}:${jobId}` : `${url.hostname}${url.pathname}${url.search}`;

    return {
      jobKey,
      jobData: {
        jobTitle: titleEl.textContent.trim(),
        company: companyEl ? companyEl.textContent.trim() : "",
        location: locationEl ? locationEl.textContent.trim() : "",
        employmentType: "",
        jobDescription: descriptionEl ? descriptionEl.innerText.trim() : "",
        jobUrl: pageUrl,
      },
    };
  }

  // LinkedIn ships no schema.org/JobPosting JSON-LD, no <h1>, no
  // role="heading", and no data-testid attributes on the job detail pane —
  // confirmed by direct inspection. Its CSS classes are content-hashed
  // (e.g. "_9c87fdd9") and regenerate on every deploy, so unlike Indeed
  // there is no selector stable enough to key off of. The only reliable
  // anchors are the document title, which LinkedIn consistently sets to
  // "{Job Title} | {Company} | LinkedIn", and the company profile link
  // (a[href*="/company/"]) — location is recovered by walking up from that
  // link and reading the ancestor's text lines structurally (company name,
  // then title, then "location · posted time · applicant count"), since
  // there's no attribute to select it by directly.
  function extractLinkedInFallback(pageUrl) {
    if (!location.hostname.includes("linkedin.")) return null;

    const titleMatch = document.title.match(/^(.+?)\s\|\s(.+?)\s\|\s*LinkedIn$/);
    if (!titleMatch) return null;
    const [, jobTitle, company] = titleMatch;

    let jobLocation = "";
    let ancestor = document.querySelector('a[href*="/company/"]');
    for (let depth = 0; depth < 6 && ancestor; depth++) {
      ancestor = ancestor.parentElement;
      if (!ancestor) break;
      const lines = ancestor.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      const line = lines.find(
        (l) => l.includes(" · ") && !/^(hybrid|remote|on-site|full-time|part-time|contract|internship)$/i.test(l)
      );
      if (line) {
        jobLocation = line.split(" · ")[0].trim();
        break;
      }
    }

    const url = new URL(pageUrl);
    const jobId = url.searchParams.get("currentJobId") || (url.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1];
    const jobKey = jobId ? `${url.hostname}:${jobId}` : `${url.hostname}${url.pathname}${url.search}`;

    return {
      jobKey,
      jobData: {
        jobTitle: jobTitle.trim(),
        company: company.trim(),
        location: jobLocation,
        employmentType: "",
        jobUrl: pageUrl,
      },
    };
  }

  // d.vinci is a white-label multi-tenant ATS — client career sites are
  // hosted at "{client}.dvinci-hr.com" and the footer reads "powered by
  // d.vinci" (confirmed on essilorluxottica.dvinci-hr.com). It ships no
  // JobPosting JSON-LD, and unlike Indeed/LinkedIn its <title>/og:title is
  // unreliable across its multi-step apply flow: the description page's
  // title is the job title, but the very next step ("choose how to apply")
  // titles itself "Auswahl der Bewerbungsart für {job title}" ("choice of
  // application type for..."), which extractGenericFallback() was reading
  // as its own separate, garbled job posting — and since that fallback keys
  // on hostname+pathname, it produced a different jobKey per step, so the
  // real job (tracked from the description page) and this bogus one never
  // matched up. The job title is consistently the page's first <h1> on
  // every step instead (confirmed on both the description page and
  // /intro), so read that directly. The job id in the URL
  // (.../jobs/<id>/<slug>, .../jobs/<id>/intro, .../jobs/<id>/apply, ...) is
  // similarly the one part stable across every step, so key on it — same
  // id-based jobKey approach as the Indeed/LinkedIn fallbacks — instead of
  // letting the pathname-based generic key fragment one job into several.
  function extractDvinciFallback(pageUrl) {
    if (!location.hostname.includes("dvinci-hr.com")) return null;

    const h1 = document.querySelector("h1");
    if (!h1 || !h1.textContent.trim()) return null;
    const jobTitle = h1.textContent.trim();

    // "{employment type} in {city}" (e.g. "befristet in Schwabach") directly
    // follows the title as a <p> on the description step only — other steps
    // don't render it, so this is best-effort and often blank.
    let jobLocation = "";
    const locationEl = h1.nextElementSibling;
    if (locationEl && locationEl.tagName === "P") {
      const text = locationEl.textContent.trim();
      const idx = text.lastIndexOf(" in ");
      jobLocation = idx === -1 ? text : text.slice(idx + 4).trim();
    }

    const idMatch = location.pathname.match(/\/jobs\/(\d+)/);
    const jobKey = idMatch ? `${location.hostname}:${idMatch[1]}` : `${location.hostname}${location.pathname}`;

    return {
      jobKey,
      jobData: {
        jobTitle,
        company: "",
        location: jobLocation,
        employmentType: "",
        jobUrl: pageUrl,
      },
    };
  }

  // The title-split heuristic below has no way to tell "{title} - {company}"
  // apart from "{video title} - YouTube" or "{post title} - Reddit" — any
  // page whose title happens to contain a GENERIC_TITLE_SEPARATORS
  // substring matches, regardless of whether the page has anything to do
  // with a job. Confirmed live: every YouTube watch page titles itself
  // "{video} - YouTube", a 100% false-positive rate on that separator alone.
  // This requires actual job context (a job-shaped URL path, or job-posting
  // language somewhere in the page) before the title split is even
  // attempted — see GENERIC_JOB_PATH_SEGMENTS / GENERIC_JOB_CONTEXT_KEYWORDS
  // in keywords.js. Trade-off: a real posting on a career site with neither
  // a job-shaped path nor any of the listed phrases still won't be caught —
  // accepted, since it's strictly better than false-triggering on every
  // non-job site with a punctuated title.
  function hasJobContext() {
    const path = location.pathname.toLowerCase();
    if (JOB_TRACKER_KEYWORDS.GENERIC_JOB_PATH_SEGMENTS.some((seg) => path.includes(seg))) return true;
    const text = document.body.innerText.toLowerCase();
    return JOB_TRACKER_KEYWORDS.GENERIC_JOB_CONTEXT_KEYWORDS.some((kw) => text.includes(kw));
  }

  // Last-resort catch-all for sites with no JobPosting JSON-LD and no
  // dedicated fallback above — makes detection work on arbitrary/unknown job
  // sites instead of only the ones explicitly special-cased. Best-effort
  // only: guessing which part of a page title is the job title vs. the
  // employer vs. the site name is inherently unreliable, so results will
  // sometimes be wrong or blank and may need correcting in the popup.
  function extractGenericFallback(pageUrl) {
    if (!hasJobContext()) return null;

    const ogTitle = document.querySelector('meta[property="og:title"]');
    const rawTitle = (ogTitle && ogTitle.content.trim()) || document.title;
    if (!rawTitle) return null;

    let jobTitle = rawTitle;
    let company = "";
    for (const sep of JOB_TRACKER_KEYWORDS.GENERIC_TITLE_SEPARATORS) {
      if (rawTitle.includes(sep)) {
        const parts = rawTitle.split(sep);
        jobTitle = parts[0].trim();
        company = parts[parts.length - 1].trim();
        break;
      }
    }
    if (!jobTitle) return null;

    return {
      jobKey: `${location.hostname}${location.pathname}`,
      jobData: {
        jobTitle,
        company,
        location: "",
        employmentType: "",
        jobUrl: pageUrl,
      },
    };
  }

  // Hosts that are never job postings but can otherwise slip past the
  // fallback chain (e.g. a Teams meeting-launch page's title happens to
  // contain " | ", which extractGenericFallback() would misread as a job
  // title/company pair). Checked before any fallback runs. See
  // content/keywords.js for the actual list.
  function isNonJobHost(hostname) {
    return JOB_TRACKER_KEYWORDS.NON_JOB_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  }

  // Search/results-listing pages (e.g. "/search/?q=...") list many jobs, not
  // one — checked before any fallback runs, same as isNonJobHost(). See
  // LISTING_PATH_SEGMENTS in keywords.js for why this matters.
  function isListingPath(pathname) {
    const lower = pathname.toLowerCase();
    return JOB_TRACKER_KEYWORDS.LISTING_PATH_SEGMENTS.some((seg) => lower.includes(seg));
  }

  // Safety net for hosts NON_JOB_HOSTS hasn't caught yet: rejects a
  // fallback-derived title/company pair that matches one of
  // JOB_TRACKER_KEYWORDS.NEGATIVE_KEYWORDS. Never applied to real
  // schema.org/JobPosting JSON-LD (see keywords.js for why).
  function isNegativeMatch(jobData) {
    const text = `${jobData.jobTitle} ${jobData.company}`.toLowerCase();
    return JOB_TRACKER_KEYWORDS.NEGATIVE_KEYWORDS.some((kw) => text.includes(kw));
  }

  // Every result carries a `source` — "jsonld" for real schema.org structured
  // data (authoritative, shown to the user as a single-step Save prompt) or
  // "fallback" for anything guessed from page structure/title (Indeed,
  // LinkedIn, d.vinci, or the generic title-split) — which the widget uses
  // to decide whether to ask "does this look like a job posting?" first.
  // See renderConfirmPrompt/scan().
  function detectJob() {
    const raw = extractJobPosting();
    if (raw) {
      const jobData = normalizeJob(raw, window.location.href);
      if (jobData.jobTitle) {
        return { jobKey: computeJobKey(raw, window.location.href), jobData, source: "jsonld" };
      }
    }

    if (isNonJobHost(location.hostname)) return null;

    let fallback;
    if (location.hostname.includes("linkedin.")) {
      // LinkedIn only ever has job postings under /jobs/ — profile, feed,
      // company, messaging, etc. pages must never fall through to the
      // generic fallback below, which would otherwise misread e.g. a
      // profile page's "{Name} | LinkedIn" title as a job posting.
      if (!location.pathname.startsWith("/jobs/")) return null;
      fallback = extractLinkedInFallback(window.location.href);
      // extractLinkedInFallback()'s title regex already only matches when a
      // specific job's detail pane is showing, so it's safe on the
      // split-pane search view. If it didn't match AND the path also looks
      // like a bare listing page (no job selected), don't fall through to
      // the generic fallback — it would misread the listing page's own
      // title (e.g. "React Developer Jobs | LinkedIn") as a job posting.
      if (!fallback && !isListingPath(location.pathname)) {
        fallback = extractGenericFallback(window.location.href);
      }
    } else {
      // Search/results-listing pages list many jobs, not one — the generic
      // fallback has no way to tell which (if any) the user is looking at,
      // so it would otherwise read the listing page's own title as a job
      // posting and collapse every job on that page into one shared jobKey.
      if (isListingPath(location.pathname)) return null;
      fallback =
        extractIndeedFallback(window.location.href) ||
        extractDvinciFallback(window.location.href) ||
        extractGenericFallback(window.location.href);
    }

    if (fallback && isNegativeMatch(fallback.jobData)) return null;
    return fallback && { ...fallback, source: "fallback" };
  }

  // Retries detectJob() for a few seconds instead of just once at
  // document_idle, since some sites inject their JobPosting JSON-LD (or
  // render the DOM a fallback reads) after the initial page load via
  // client-side JS.
  function waitForDetection({ attempts = 6, intervalMs = 1000 } = {}) {
    return new Promise((resolve) => {
      const tryDetect = (remaining) => {
        const result = detectJob();
        if (result || remaining <= 0) {
          resolve(result);
          return;
        }
        setTimeout(() => tryDetect(remaining - 1), intervalMs);
      };
      tryDetect(attempts);
    });
  }

  // Builds the floating bottom-right widget inside a shadow root, so its
  // styles can never leak into (or be overridden by) the host page's CSS
  // and vice versa — important since this gets injected into arbitrary
  // third-party sites. Returns both the outer host element (to remove the
  // whole widget later) and the inner .card (to swap its contents between
  // prompt states).
  function createWidget() {
    const host = document.createElement("div");
    host.id = "job-tracker-widget-host";
    host.style.position = "fixed";
    host.style.bottom = "16px";
    host.style.right = "16px";
    host.style.zIndex = "2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .card {
          width: 260px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 13px;
          background: #fff;
          color: #1a1a1a;
          border: 1px solid #d0d0d0;
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
          padding: 12px;
          position: relative;
        }
        .title { font-weight: 700; margin-bottom: 4px; }
        .job { color: #444; margin-bottom: 8px; }
        .question { margin-bottom: 8px; }
        .field-label { display: block; font-size: 11px; color: #666; margin-bottom: 3px; }
        .field-input {
          display: block;
          width: 100%;
          padding: 5px 6px;
          margin-bottom: 8px;
          border: 1px solid #d0d0d0;
          border-radius: 4px;
          font-size: 12px;
          font-family: inherit;
          box-sizing: border-box;
        }
        textarea.field-input { resize: vertical; }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .actions.grid { display: grid; grid-template-columns: 1fr 1fr; }
        button.action {
          flex: 1;
          padding: 6px 8px;
          border: none;
          border-radius: 5px;
          background: #2563eb;
          color: #fff;
          font-size: 12px;
          cursor: pointer;
        }
        button.action.secondary { background: #f0f0f0; color: #333; }
        button.remove-button { display: block; width: 100%; margin-top: 6px; }
        button.close {
          position: absolute;
          top: 4px;
          right: 6px;
          border: none;
          background: none;
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          color: #888;
        }
        .confirmation { color: #166534; font-weight: 600; }
        .error-text { color: #dc2626; font-size: 11px; margin: -2px 0 8px; }
        .hidden { display: none; }
      </style>
      <div class="card"></div>
    `;
    document.body.appendChild(host);
    return { host, card: shadow.querySelector(".card") };
  }

  // host.remove() takes the shadow root and everything in it with it —
  // nothing else to clean up.
  function removeWidget(host) {
    host.remove();
  }

  const HINT_HOST_ID = "job-tracker-hint-host";

  function removeHintIcon() {
    const existing = document.getElementById(HINT_HOST_ID);
    if (existing) existing.remove();
  }

  // Manual mode's stand-in for the auto-popup widget (see scan() below):
  // instead of the full card appearing unprompted, a small round icon
  // appears bottom-LEFT (deliberately the opposite corner from the widget's
  // bottom-right, so the two are never confusable at a glance) and shakes
  // briefly to catch the eye without being a permanent distraction — it
  // animates a few times on appearing, then just sits still until clicked
  // or the page navigates away. Clicking it removes the icon and runs
  // `reveal`, which is whichever widget (track/confirm/status-update) auto
  // mode would have shown directly — same rendering code either way, this
  // just gates *when* it appears behind an explicit click.
  //
  // `variant` swaps the icon/tooltip for the not-logged-in case (see
  // scan()) — 🔒 rather than 💼, so the icon itself signals *why* it's
  // there before it's even clicked, not just on the click.
  function showHintIcon(reveal, variant = {}) {
    const { icon = "💼", title = "Job Tracker found something on this page — click to review" } = variant;
    removeHintIcon();

    const host = document.createElement("div");
    host.id = HINT_HOST_ID;
    host.style.position = "fixed";
    host.style.bottom = "16px";
    host.style.left = "16px";
    host.style.zIndex = "2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        @keyframes job-tracker-shake {
          0%, 100% { transform: translateX(0) rotate(0); }
          15% { transform: translateX(-4px) rotate(-8deg); }
          30% { transform: translateX(4px) rotate(8deg); }
          45% { transform: translateX(-4px) rotate(-6deg); }
          60% { transform: translateX(4px) rotate(6deg); }
          75% { transform: translateX(-2px) rotate(-2deg); }
          90% { transform: translateX(2px) rotate(2deg); }
        }
        .hint-button {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: none;
          background: #2563eb;
          color: #fff;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0,0,0,0.3);
          animation: job-tracker-shake 0.6s ease-in-out 3;
          animation-delay: 0.4s;
        }
        .hint-button:hover {
          animation: none;
          transform: scale(1.08);
        }
      </style>
      <button class="hint-button" title="${title}">${icon}</button>
    `;
    document.body.appendChild(host);
    shadow.querySelector(".hint-button").addEventListener("click", () => {
      removeHintIcon();
      reveal();
    });
  }

  // chrome.tabs isn't exposed to content-script context (same story as
  // chrome.action — see the note at the top of background.js), so opening
  // the Dashboard has to relay through the background service worker
  // rather than calling chrome.tabs.create directly here.
  function openDashboard() {
    chrome.runtime.sendMessage({ type: "job-tracker:openDashboard" });
  }

  // Swaps the widget's content for a brief green confirmation line, then
  // auto-removes the whole widget after 1.2s — used after every action
  // (Save, status update, Remove) so the widget doesn't linger once it's
  // done its job.
  function showConfirmationThenRemove(card, host, message) {
    card.innerHTML = `<div class="confirmation">${message}</div>`;
    setTimeout(() => removeWidget(host), 1200);
  }

  // Pops up a standalone confirmation widget with no prompt beforehand —
  // used by checkApplyCompletion() below, which can fire on a page where no
  // track/status-update widget was ever shown (Apply often redirects to an
  // ATS on a different origin than where the job was detected).
  function showToast(message) {
    const existing = document.getElementById("job-tracker-widget-host");
    if (existing) existing.remove();
    removeHintIcon();
    const { host, card } = createWidget();
    showConfirmationThenRemove(card, host, message);
  }

  // jobTitle/company ultimately come from page content (JSON-LD, document
  // title, etc.) and are attacker-influenceable, so they're never inserted
  // into widget innerHTML unescaped.
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // escapeHtml() above is only safe in a text-node context — the
  // textContent→innerHTML roundtrip doesn't escape `"`, since quotes have
  // no special meaning in text content, only inside an attribute's value.
  // renderTrackPrompt below puts scraped values into `value="..."`
  // attributes, where an unescaped `"` would break out of the attribute
  // and let attacker-controlled page content (a crafted job title) inject
  // arbitrary markup — so those specifically go through this instead.
  function escapeAttr(str) {
    return (str == null ? "" : String(str)).replace(/"/g, "&quot;");
  }

  // Shown when the 🔒 hint icon is clicked (see the not-logged-in branch of
  // scan()) — a real choice between the two, not an immediate redirect.
  // Signing up still always goes to the Dashboard (see CLAUDE.md's "Real
  // Backend" section for why account creation stays there), but logging in
  // with an existing account is common enough, and simple enough, that
  // making the user leave the page just to type an email/password they
  // already have is unnecessary friction — renderInlineLoginForm below
  // handles that right here instead.
  function renderLoginOrSignupPrompt(card, host) {
    card.innerHTML = `
      <button class="close">&times;</button>
      <div class="title">Job Tracker</div>
      <div class="question">Log in or sign up to track this job.</div>
      <div class="actions">
        <button class="action" data-action="login">Log In</button>
        <button class="action secondary" data-action="signup">Sign Up</button>
      </div>
    `;
    card.querySelector(".close").addEventListener("click", () => removeWidget(host));
    card.querySelector('[data-action="signup"]').addEventListener("click", () => {
      openDashboard();
      removeWidget(host);
    });
    card.querySelector('[data-action="login"]').addEventListener("click", () => {
      renderInlineLoginForm(card, host);
    });
  }

  // A real, minimal email/password form right in the widget. On success,
  // re-runs scan() so the actual track/status prompt this job deserves
  // takes over immediately, instead of leaving the user to figure out they
  // need to revisit or refresh.
  function renderInlineLoginForm(card, host) {
    card.innerHTML = `
      <button class="close">&times;</button>
      <div class="title">Log In</div>
      <label class="field-label">Email</label>
      <input class="field-input" type="email" data-field="email" />
      <label class="field-label">Password</label>
      <input class="field-input" type="password" data-field="password" />
      <p class="error-text hidden"></p>
      <div class="actions">
        <button class="action" data-action="submit">Log In</button>
      </div>
    `;
    card.querySelector(".close").addEventListener("click", () => removeWidget(host));
    const errorEl = card.querySelector(".error-text");
    const submitButton = card.querySelector('[data-action="submit"]');
    submitButton.addEventListener("click", async () => {
      const email = card.querySelector('[data-field="email"]').value.trim();
      const password = card.querySelector('[data-field="password"]').value;
      errorEl.classList.add("hidden");
      submitButton.disabled = true;
      submitButton.textContent = "Logging in…";
      try {
        await login(email, password);
        showConfirmationThenRemove(card, host, "Logged in ✓");
        scan();
      } catch (err) {
        if (isContextInvalidated(err)) return;
        errorEl.textContent = err.message;
        errorEl.classList.remove("hidden");
        submitButton.disabled = false;
        submitButton.textContent = "Log In";
      }
    });
  }

  // Shown instead of renderTrackPrompt for "fallback"-sourced detections
  // (see detectJob()'s `source` tag) — i.e. anything guessed from page
  // title/structure rather than real schema.org/JobPosting data, which is
  // exactly the category prone to false positives (a YouTube video's
  // "{title} - YouTube", a Reddit post, ...). Shows whatever title/company
  // was actually extracted (same as renderTrackPrompt's .job line) so the
  // user can judge the guess for themselves, then asks the concrete
  // question that actually matters — "Are you applying here?" — rather than
  // the more abstract "is this a job posting?". Only "Yes" reveals the
  // status picker and Save button (by re-rendering into renderTrackPrompt).
  // "No" and "×" both just close the widget without persisting anything —
  // same as every other dismiss in this file — so it asks again on the next
  // visit rather than remembering a "no" forever (this MVP has no
  // per-jobKey suppression list, by design — see CLAUDE.md).
  function renderConfirmPrompt(card, host, jobKey, jobData) {
    card.innerHTML = `
      <button class="close">&times;</button>
      <div class="title">Job Tracker</div>
      <div class="job">${escapeHtml(jobData.jobTitle) || "This page"}${jobData.company ? ` · ${escapeHtml(jobData.company)}` : ""}</div>
      <div class="question">Are you applying here?</div>
      <div class="actions">
        <button class="action" data-action="yes">Yes</button>
        <button class="action secondary" data-action="no">No</button>
      </div>
    `;
    card.querySelector('[data-action="yes"]').addEventListener("click", () => {
      renderTrackPrompt(card, host, jobKey, jobData);
    });
    card.querySelector('[data-action="no"]').addEventListener("click", () => removeWidget(host));
    card.querySelector(".close").addEventListener("click", () => removeWidget(host));
  }

  // The full editable form — job title, company, location, URL, employment
  // type, status, application date, notes — same field set as the popup's
  // "Add Manually" tab. Doubles as both the "track a new job" form (no
  // `existingRecord`: fields pre-filled from the page's detected `jobData`,
  // Save calls addApplication) and the "update an already-tracked job" form
  // (`existingRecord` passed: fields pre-filled from the record itself,
  // Save calls updateApplication) — one rendering path for both, since the
  // only real difference is which values seed the fields and which storage
  // call Save makes. Fields are genuinely editable (not a read-only
  // title/company summary) specifically so a wrong or incomplete
  // auto-detected guess can be fixed right here instead of needing a trip
  // to the popup.
  //
  // Viewing a job never persists anything by itself — a record is only
  // created/updated here if the user clicks Save, or separately if they
  // click something that looks like an Apply button (see the pointerdown
  // listener below, which always creates with "Pending" since there's no
  // widget interaction to pick a status from in that path). Dismissing (×)
  // just closes the widget for this page view; nothing is saved, so it
  // prompts again on the next visit. For "fallback"-sourced detections in
  // auto mode this is only ever shown after the user has already said "Yes"
  // on renderConfirmPrompt above — real "jsonld"-sourced detections, and
  // every manual-mode case (see scan()), skip straight here.
  function renderTrackPrompt(card, host, jobKey, jobData, existingRecord) {
    const base = existingRecord || jobData;
    const status = existingRecord ? existingRecord.status : "Pending";
    // Pre-filling today's date by default (not just leaving it blank)
    // mirrors popup.js's resetForm() — most people filling this in are
    // doing so today, and it's one less thing to type; still just a
    // starting value, freely editable or clearable.
    const applicationDate = existingRecord
      ? existingRecord.applicationDate || ""
      : new Date().toISOString().slice(0, 10);
    const notes = existingRecord ? existingRecord.notes || "" : "";
    const statusOptions = TRACK_STATUSES.map(
      (s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s}</option>`
    ).join("");

    card.innerHTML = `
      <button class="close">&times;</button>
      <div class="title">Job Tracker</div>
      <div class="question">${existingRecord ? "Update this application" : "Track this application?"}</div>
      <label class="field-label">Job Title</label>
      <input class="field-input" data-field="jobTitle" type="text" value="${escapeAttr(base.jobTitle)}" />
      <label class="field-label">Company</label>
      <input class="field-input" data-field="company" type="text" value="${escapeAttr(base.company)}" />
      <label class="field-label">Location</label>
      <input class="field-input" data-field="location" type="text" value="${escapeAttr(base.location)}" />
      <label class="field-label">Job URL</label>
      <input class="field-input" data-field="jobUrl" type="url" value="${escapeAttr(base.jobUrl)}" />
      <label class="field-label">Employment Type</label>
      <input class="field-input" data-field="employmentType" type="text" value="${escapeAttr(base.employmentType)}" />
      <label class="field-label">Status</label>
      <select class="field-input status-select">${statusOptions}</select>
      <label class="field-label">Application Date</label>
      <input class="field-input" data-field="applicationDate" type="date" value="${escapeAttr(applicationDate)}" />
      <label class="field-label">Notes</label>
      <textarea class="field-input" data-field="notes" rows="2">${escapeHtml(notes)}</textarea>
      <div class="actions">
        <button class="action" data-action="save">Save</button>
      </div>
    `;
    card.querySelector('[data-action="save"]').addEventListener("click", async () => {
      try {
        const field = (name) => card.querySelector(`[data-field="${name}"]`).value.trim();
        const data = {
          jobTitle: field("jobTitle"),
          company: field("company"),
          location: field("location"),
          jobUrl: field("jobUrl"),
          employmentType: field("employmentType"),
          status: card.querySelector(".status-select").value,
          applicationDate: field("applicationDate"),
          notes: field("notes"),
          // Not an editable field on this compact widget (see the field list
          // above — only the dashboard's application-form has a Job
          // Description textarea), but it's silently DROPPED if omitted here
          // — a real bug, confirmed live, not hypothetical: whatever
          // normalizeJob()/extractIndeedFallback() actually captured on the
          // page (JSON-LD description, or now Indeed's #jobDescriptionText)
          // was being thrown away the moment the user clicked Save on this
          // widget, degrading every cover letter generated from that record
          // to the generic "no job description was captured" fallback even
          // though a real description had been scraped. base.jobDescription
          // carries it through unedited instead.
          jobDescription: base.jobDescription || "",
        };
        const record = existingRecord
          ? await updateApplication(existingRecord.id, data)
          : await addApplication({ ...data, jobKey });
        currentRecord = record;
        showConfirmationThenRemove(card, host, `Tracking "${record.jobTitle}" as ${data.status} ✓`);
      } catch (err) {
        if (!isContextInvalidated(err)) throw err;
      }
    });
    card.querySelector(".close").addEventListener("click", () => removeWidget(host));
  }

  // Auto mode only now (see scan()): shown on revisiting a job page that's
  // already tracked with an active status (Applied/Interview — see
  // ACTIVE_STATUSES in shared/constants.js). "Applied" isn't offered as a
  // target here since a record reaching this widget is already Applied or
  // further along — manual mode's equivalent case goes through
  // renderTrackPrompt's full editable form instead (with the existing
  // record's data pre-filled), which does offer every status including
  // Applied, since that path can also start from a still-Pending record.
  function renderStatusUpdatePrompt(card, host, record) {
    const options = [
      { status: "Interview", label: "Interview" },
      { status: "Offer", label: "Offer" },
      { status: "Rejected", label: "Rejected" },
      { status: "Ghosted", label: "Ghosted" },
    ];
    card.innerHTML = `
      <button class="close">&times;</button>
      <div class="title">Job Tracker</div>
      <div class="job">${escapeHtml(record.jobTitle)} · ${escapeHtml(record.company)}</div>
      <div class="question">Any update on this application?</div>
      <div class="actions grid">
        ${options.map((o) => `<button class="action" data-status="${o.status}">${o.label}</button>`).join("")}
      </div>
      <button class="action secondary remove-button">Remove from list</button>
    `;
    card.querySelectorAll("[data-status]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          const status = button.dataset.status;
          const updates = { status };
          // Same reasoning as renderTrackPrompt: a record moving past
          // Pending should carry a date, not stay blank — matters here
          // specifically for the new Pending → Applied transition, which
          // previously could only happen via the popup or
          // checkApplyCompletion()'s own auto-detected date stamp.
          if (status !== "Pending" && !record.applicationDate) {
            updates.applicationDate = new Date().toISOString().slice(0, 10);
          }
          await updateApplication(record.id, updates);
          showConfirmationThenRemove(card, host, `Saved — marked as ${status} ✓`);
        } catch (err) {
          if (!isContextInvalidated(err)) throw err;
        }
      });
    });
    card.querySelector(".remove-button").addEventListener("click", async () => {
      try {
        await deleteApplication(record.id);
        if (currentRecord && currentRecord.id === record.id) currentRecord = null;
        showConfirmationThenRemove(card, host, "Removed from list");
      } catch (err) {
        if (!isContextInvalidated(err)) throw err;
      }
    });
    card.querySelector(".close").addEventListener("click", () => removeWidget(host));
  }

  // The job currently detected on this page, if any (jobKey + jobData from
  // detectJob()) — kept up to date by scan() regardless of whether it's
  // tracked yet, since the apply-click listener below needs it to create a
  // record on the fly when the user clicks Apply before ever clicking Save.
  let currentDetection = null;
  // The persisted record for currentDetection, if one exists yet. Null until
  // the user clicks Save on the track-prompt widget, or clicks something
  // that looks like an Apply button (see the pointerdown listener below) —
  // viewing a job page alone never creates one.
  let currentRecord = null;

  function isApplyElement(el) {
    const text = (el.textContent || "").trim().toLowerCase();
    if (!text || text.length > 40) return false; // skip large containers, not buttons
    return JOB_TRACKER_KEYWORDS.APPLY_KEYWORDS.some((kw) => {
      // Bare single-word keywords ("apply", "bewerben") only count when the
      // element's *entire* text is that word — substring-matching them would
      // also fire on "Apply Filters" (search facets), "How to Apply" (an
      // in-page jump link inside the job description), etc., silently
      // tracking a job the user never actually clicked Apply on. Multi-word
      // phrases ("apply now", "jetzt bewerben", ...) are specific enough
      // that a substring match is safe to keep.
      if (kw.includes(" ")) return text === kw || text.includes(kw);
      return text === kw;
    });
  }

  // Element types that can plausibly be a real "Apply" control — narrows
  // what isApplyElement() below even bothers text-matching against.
  function isClickable(el) {
    return (
      el.tagName === "BUTTON" ||
      el.tagName === "A" ||
      (el.tagName === "INPUT" && el.type === "submit") ||
      el.getAttribute("role") === "button"
    );
  }

  // Marking Applied happens on detected *completion*, not on the apply click
  // itself (see checkApplyCompletion below) — clicking Apply often only
  // starts a multi-step flow (an ATS redirect, a new tab, a multi-page
  // LinkedIn Easy Apply modal), so this "watch" is persisted to
  // chrome.storage.local rather than kept in a JS variable: it must survive
  // the current page's content script context being torn down by a full
  // navigation, and must be visible to a content script running on a
  // different page (or a different tab entirely, if Apply opened one) that
  // may be where the completion signal actually shows up.
  const APPLY_WATCH_KEY = "jobTrackerApplyWatch";
  // Only one apply attempt is watched globally at a time — starting a new
  // one overwrites/abandons any prior unfinished watch. Accepted MVP
  // trade-off rather than tracking multiple concurrent in-flight applies.
  const APPLY_WATCH_TTL_MS = 30 * 60 * 1000;

  // Fires on pointerdown (not click) and in the capture phase, to run as
  // early as possible before the page's own handler can navigate away —
  // click/navigation races are a real risk here since the async storage
  // write needs to complete before this page's JS context is torn down.
  // Clicking Apply is itself one of the two explicit actions that tracks a
  // job (the other is Save on the track-prompt widget — see renderTrackPrompt
  // and scan()), so if nothing is tracked yet for this page this listener
  // creates the record (status "Pending") before arming the watch, rather
  // than requiring the user to have clicked Save first.
  document.addEventListener(
    "pointerdown",
    async (event) => {
      try {
        if (!currentDetection) return;
        // Manual mode: don't auto-create a record or arm a watch just
        // because the user clicked something that looks like Apply —
        // tracking only ever happens via the popup's explicit Save now.
        if (!(await isAutoDetectEnabled())) return;
        if (currentRecord && currentRecord.status !== "Pending") return;
        let el = event.target;
        for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
          if (isClickable(el) && isApplyElement(el)) {
            let record = currentRecord;
            if (!record) {
              record = await addApplication({ ...currentDetection.jobData, jobKey: currentDetection.jobKey, status: "Pending" });
              currentRecord = record;
            }
            await chrome.storage.local.set({
              [APPLY_WATCH_KEY]: {
                jobKey: record.jobKey,
                recordId: record.id,
                jobTitle: record.jobTitle,
                company: record.company,
                armedAt: Date.now(),
              },
            });
            break;
          }
        }
      } catch (err) {
        if (!isContextInvalidated(err)) throw err;
      }
    },
    true
  );

  // Whole-page text scan for a SUCCESS_KEYWORDS phrase — called only while
  // an apply watch is armed (see checkApplyCompletion below), so this cost
  // is bounded to that ~30-minute window rather than running on every page.
  function detectApplicationSuccess() {
    const text = document.body.innerText.toLowerCase();
    return JOB_TRACKER_KEYWORDS.SUCCESS_KEYWORDS.some((kw) => text.includes(kw));
  }

  // Polled alongside handleUrlChange (see the setInterval below) rather than
  // driven by a MutationObserver: the completion signal can appear on a
  // brand-new page (this function only runs at all if a watch was armed
  // and persisted, so cost is bounded to that window) after a full
  // navigation, where no observer would already be attached in time.
  async function checkApplyCompletion() {
    try {
      const result = await chrome.storage.local.get(APPLY_WATCH_KEY);
      const watch = result[APPLY_WATCH_KEY];
      if (!watch) return;

      const age = Date.now() - watch.armedAt;
      if (age > APPLY_WATCH_TTL_MS) {
        await chrome.storage.local.remove(APPLY_WATCH_KEY);
        return;
      }
      // Skip the tick right after arming so we don't match leftover text from
      // the pre-apply page before it's had a chance to transition.
      if (age < 1500) return;

      if (!detectApplicationSuccess()) return;

      await chrome.storage.local.remove(APPLY_WATCH_KEY);
      const updated = await updateApplication(watch.recordId, {
        status: "Applied",
        applicationDate: new Date().toISOString().slice(0, 10),
      });
      if (!updated) return;
      if (currentRecord && currentRecord.id === updated.id) currentRecord = updated;
      showToast(`Tracking "${watch.jobTitle}" as Applied ✓`);
    } catch (err) {
      if (!isContextInvalidated(err)) throw err;
    }
  }

  let scanToken = 0;

  async function scan() {
    const token = ++scanToken;

    try {
      const detected = await waitForDetection();
      if (token !== scanToken) return; // superseded by a newer navigation

      if (!detected) {
        currentDetection = null;
        currentRecord = null;
        notifyBadge(false);
        // A widget (or hint icon) from a *previous* page can still be
        // sitting in the DOM here: on an SPA (YouTube, Reddit, ...)
        // navigating from a detected job to a non-job page happens via
        // pushState, not a full reload, so nothing else ever tears it down.
        // Clear both whenever this page has nothing to show, not just when
        // a new detection is about to replace one of them below.
        const staleHost = document.getElementById("job-tracker-widget-host");
        if (staleHost) staleHost.remove();
        removeHintIcon();
        return;
      }

      currentDetection = detected;
      notifyBadge(true);
      const { jobKey, jobData, source } = detected;

      // Not logged in: every request past this point would just 401, and
      // there's no record to look up anyway. A small non-intrusive hint
      // icon (not a full auto-popped widget, regardless of the auto-detect
      // setting) nudges toward logging in without nagging on every single
      // job page visited before that first login happens — 🔒 instead of
      // the usual 💼 so the icon itself signals *why* it's there. Clicking
      // it reveals a real choice (renderLoginOrSignupPrompt), not an
      // immediate redirect: logging in with an existing account happens
      // right there via renderInlineLoginForm, signing up still always
      // goes to the Dashboard (see CLAUDE.md's "Real Backend" section).
      const authToken = await getAuthToken();
      if (!authToken) {
        currentRecord = null;
        const existingHost = document.getElementById("job-tracker-widget-host");
        if (existingHost) existingHost.remove();
        removeHintIcon();
        showHintIcon(
          () => {
            const { host, card } = createWidget();
            renderLoginOrSignupPrompt(card, host);
          },
          { icon: "🔒", title: "Log in or sign up to track this job" }
        );
        return;
      }

      const record = await getApplicationByJobKey(jobKey);

      if (token !== scanToken) return;

      currentRecord = record;

      const existingHost = document.getElementById("job-tracker-widget-host");
      if (existingHost) existingHost.remove();
      removeHintIcon();

      const autoDetectEnabled = await isAutoDetectEnabled();

      // Figure out *what* would be shown, without showing it yet — a
      // closure so both branches below (auto mode: show it now; manual
      // mode: show it only after the hint icon is clicked) can share the
      // exact same rendering code instead of duplicating it. What gets
      // built differs slightly by mode in both branches below — see each
      // comment for why.
      let reveal = null;
      if (!record) {
        if (autoDetectEnabled && source === "fallback") {
          // Auto-popup only: confirm-first for "fallback"-sourced guesses
          // (Indeed/LinkedIn/d.vinci/generic — see detectJob()), since
          // these are the false-positive-prone ones and this version of
          // the widget appears completely unprompted. Manual mode always
          // skips straight to the full form below instead — clicking the
          // hint icon already *is* the user's explicit "yes, look at this"
          // signal, so the extra gate would just be friction, not safety.
          reveal = () => {
            const { host, card } = createWidget();
            renderConfirmPrompt(card, host, jobKey, jobData);
          };
        } else {
          reveal = () => {
            const { host, card } = createWidget();
            renderTrackPrompt(card, host, jobKey, jobData);
          };
        }
      } else if (autoDetectEnabled) {
        // Auto mode keeps the original, narrower trigger: only an active
        // Applied/Interview revisit gets a widget at all (see step 7 in
        // CLAUDE.md — Pending/terminal stays silent to avoid nagging on
        // every single revisit), and it's the compact status-only prompt.
        if (ACTIVE_STATUSES.includes(record.status)) {
          reveal = () => {
            const { host, card } = createWidget();
            renderStatusUpdatePrompt(card, host, record);
          };
        }
      } else {
        // Manual mode: asks about an already-tracked job regardless of its
        // current status (no nagging risk to guard against — the hint icon
        // only appears once per page load and only does anything on an
        // explicit click), and always via the same full editable form as
        // the "not yet tracked" branch above — pre-filled from the existing
        // record, Save updates it instead of creating a duplicate.
        reveal = () => {
          const { host, card } = createWidget();
          renderTrackPrompt(card, host, jobKey, jobData, record);
        };
      }

      if (!reveal) return;

      if (autoDetectEnabled) {
        reveal();
      } else {
        // Manual mode: never interrupt on its own. The small bottom-left
        // icon (opposite corner from the widget, so the two are never
        // confused) is the only thing that appears unprompted; clicking it
        // is what actually reveals the track/confirm/status-update prompt.
        showHintIcon(reveal);
      }
    } catch (err) {
      if (!isContextInvalidated(err)) throw err;
    }
  }

  // Answers the popup's manual "grab info from this page" request (see
  // tryAutoFillFromActiveTab() in popup.js, used when auto-detect is off).
  // currentDetection is usually already populated by the time a user
  // deliberately clicks the toolbar icon, but if scan() hasn't settled yet
  // (or found nothing on its own document_idle + retry pass), fall back to
  // one immediate, non-retrying detectJob() call rather than making the
  // popup wait out the full multi-second retry loop in waitForDetection().
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "job-tracker:getDetection") return false;
    if (currentDetection) {
      sendResponse(currentDetection);
      return false;
    }
    try {
      sendResponse(detectJob());
    } catch {
      sendResponse(null);
    }
    return false;
  });

  // Many job boards (Indeed, LinkedIn, Glassdoor, ...) load a clicked job into
  // the current page via client-side routing instead of a full navigation, so
  // a one-time run at document_idle would otherwise miss it entirely. Patch
  // history.pushState/replaceState (and listen for popstate) to re-scan
  // whenever the URL changes without a page reload.
  let currentUrl = location.href;
  let debounceTimer;

  // Debounces scan() by 300ms after a URL change — an SPA router can fire
  // several pushState calls in quick succession while settling on a page,
  // and re-scanning (which itself retries for a few seconds, see
  // waitForDetection) on every single one would be wasteful.
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, 300);
  }

  // Only re-scans if the URL actually changed — this is called on every
  // patched pushState/replaceState/popstate AND on every 1s interval tick,
  // so most calls are no-ops.
  function handleUrlChange() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    scheduleScan();
  }

  for (const methodName of ["pushState", "replaceState"]) {
    const original = history[methodName];
    history[methodName] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event("job-tracker:locationchange"));
      return result;
    };
  }
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("job-tracker:locationchange")));
  window.addEventListener("job-tracker:locationchange", handleUrlChange);

  // Belt-and-suspenders: if the page's own router captured a reference to
  // the original pushState/replaceState before this content script patched
  // them (a real race — content scripts run after document_idle, well after
  // a heavy SPA's bundle has already initialized its router), the patch
  // above never fires for later in-page navigations. A cheap interval poll
  // catches any URL change regardless of how it happened. checkApplyCompletion
  // rides the same tick — it's a cheap no-op unless a watch is armed.
  setInterval(() => {
    handleUrlChange();
    checkApplyCompletion();
  }, 1000);

  scan();
})();
