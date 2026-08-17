// Classic script (no import/export) — see the note atop detect.js for why
// content scripts can't use ES modules, and therefore can't `import` a JSON
// file either without an async fetch. Loaded before content/detect.js in
// manifest.json's content_scripts "js" array; scripts in the same entry run
// in file order sharing one global scope, so this top-level `const` is
// visible there without any explicit wiring.
//
// Centralizes every keyword/host/phrase list used for job detection so
// scaling coverage (a new job board, a new apply/success phrase, a new
// false-positive site) or debugging a bad match means editing this file,
// not the detection logic in detect.js.
const JOB_TRACKER_KEYWORDS = {
  // Hosts that are never job postings, checked before any fallback runs in
  // detectJob(). Add a host here the moment a false positive traces back to
  // it (e.g. a meeting-launch page whose title happens to look like
  // "{title} | {company}"). This can never be an exhaustive list of "every
  // non-job site" — it's a cheap fast-path for high-traffic sites confirmed
  // (or very likely) to trigger extractGenericFallback()'s title-split
  // false positive, layered on top of the job-context gate in
  // extractGenericFallback() itself (see GENERIC_JOB_PATH_SEGMENTS /
  // GENERIC_JOB_CONTEXT_KEYWORDS below), which is the actual scalable
  // defense. Expanding this as further false positives are found is
  // expected routine maintenance, same as NEGATIVE_KEYWORDS/SUCCESS_KEYWORDS.
  //
  // IMPORTANT when adding an entry: isNonJobHost() matches subdomains too
  // (hostname === host OR hostname endsWith "."+host), and some companies
  // host their real careers page on a *subdomain of the same domain* (e.g.
  // Netflix's jobs are at jobs.netflix.com, Google's at careers.google.com)
  // — a bare "netflix.com"/"google.com" entry would silently swallow those
  // too. Use the exact consumer-facing subdomain (e.g. "www.netflix.com")
  // instead of the bare domain wherever that risk exists. Never add any
  // "linkedin.com" host here — LinkedIn is already handled by its own
  // /jobs/-path gating further down in detectJob(), which runs *after* this
  // check; adding it here would short-circuit that and break LinkedIn
  // detection entirely rather than refine it.
  NON_JOB_HOSTS: [
    "teams.microsoft.com",
    "meet.google.com",
    "zoom.us",
    "webex.com",
    "gotomeeting.com",
    // Social / video / community — the sites this fix was written for
    // (YouTube's "{video} - YouTube" title format false-positives on every
    // single video; Reddit post titles routinely contain a stray " - ").
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "www.reddit.com",
    "old.reddit.com",
    "www.facebook.com",
    "m.facebook.com",
    "www.instagram.com",
    "twitter.com",
    "x.com",
    "www.tiktok.com",
    "www.pinterest.com",
    // Streaming — netflix.com/twitch.tv kept as exact subdomains since
    // Netflix's own job board lives at jobs.netflix.com, a subdomain of
    // the same domain (see the IMPORTANT note above).
    "www.netflix.com",
    "www.twitch.tv",
    // Reference
    "en.wikipedia.org",
    // Shopping
    "www.amazon.com",
    // Google properties — kept as exact subdomains, not bare "google.com",
    // since Google's own careers site is careers.google.com (a subdomain).
    "www.google.com",
    "mail.google.com",
    "drive.google.com",
    "docs.google.com",
    "calendar.google.com",
    // Dev tools/docs — high-traffic while coding, same category as the
    // PyCharm-download false positive that prompted this list.
    "stackoverflow.com",
    "www.npmjs.com",
    "developer.mozilla.org",
  ],

  // Substrings checked against location.pathname (lowercased) to bail out of
  // fallback detection entirely on search/results-listing pages — pages that
  // list many jobs, not one. Without this, extractGenericFallback() reads the
  // listing page's own title as if it were a single job posting, and jobKey
  // collapses to hostname+pathname (query strings like "?q=..." are ignored,
  // see computeJobKey/extractGenericFallback in detect.js), so every visit to
  // that same search path — regardless of which job the user actually looked
  // at — reuses one bogus shared record instead of tracking nothing.
  LISTING_PATH_SEGMENTS: ["/search", "/results"],

  // Substrings that disqualify a fallback-derived title/company from being
  // tracked, checked against `"{jobTitle} {company}"` for whatever a
  // fallback (LinkedIn/Indeed/generic) produced. Never applied to real
  // schema.org/JobPosting JSON-LD — that's structured, authoritative data
  // and isn't second-guessed by a keyword list. Kept as multi-word phrases
  // where possible so a real title like "Meeting Planner" or "Conference
  // Coordinator" doesn't get rejected by a bare "meeting" match.
  NEGATIVE_KEYWORDS: [
    "join meeting",
    "meeting invite",
    "calendar invite",
    "video call",
    "conference call",
    "webinar registration",
    "zoom meeting",
    "teams meeting",
    "google meet",
  ],

  // Text matched (exact or substring) against clickable elements to detect
  // an "Apply" button/link. English + German.
  APPLY_KEYWORDS: [
    "apply now",
    "easy apply",
    "quick apply",
    "submit application",
    "apply",
    "jetzt bewerben",
    "bewerbung absenden",
    "bewerbung senden",
    "bewerbung abschicken",
    "bewerben",
  ],

  // Phrases scanned for on the page after an apply watch is armed, to detect
  // that an application actually went through. Deliberately multi-word —
  // job boards routinely show unrelated text like "32 people applied" that
  // would false-positive on a looser single-word match. English + German.
  SUCCESS_KEYWORDS: [
    "application submitted",
    "application sent",
    "your application was sent",
    "your application has been submitted",
    "successfully applied",
    "application received",
    "thanks for applying",
    "thank you for applying",
    "application complete",
    "you applied to this job",
    "bewerbung gesendet",
    "bewerbung wurde gesendet",
    "bewerbung erfolgreich",
    "erfolgreich beworben",
    "vielen dank für ihre bewerbung",
    "vielen dank für deine bewerbung",
    "ihre bewerbung wurde übermittelt",
    "bewerbung eingegangen",
  ],

  // Separators extractGenericFallback() splits "{title} {sep} {company}" on.
  GENERIC_TITLE_SEPARATORS: [" | ", " :: ", " - ", " – ", " at "],

  // Job-context gate for extractGenericFallback(): the separator-based title
  // split alone is far too permissive — any page whose title happens to
  // contain " - "/" | " (a YouTube video's "{title} - YouTube", a Reddit
  // post, a blog post, a product page...) gets misread as a job posting.
  // Confirmed live: every YouTube watch page titles itself "{video title} -
  // YouTube", matching " - " on 100% of videos. Before the title split even
  // runs, extractGenericFallback() now requires ONE of these two signals —
  // either the URL path looks job-related, or the page body mentions
  // job-posting-shaped language — so a page needs actual job context, not
  // just title punctuation, to be treated as a posting. English + German
  // (matching the rest of this file's bilingual coverage).
  GENERIC_JOB_PATH_SEGMENTS: [
    "/job",
    "/jobs",
    "/career",
    "/careers",
    "/vacanc", // vacancy, vacancies
    "/position",
    "/opening",
    "/stelle", // German: Stelle/Stellen(angebot)
    "/karriere",
    "/emploi", // French, common on multinational career sites
    "/vacature", // Dutch, same reasoning
  ],
  GENERIC_JOB_CONTEXT_KEYWORDS: [
    "job description",
    "responsibilities",
    "qualifications",
    "years of experience",
    "job type",
    "employment type",
    "we are looking for",
    "apply now",
    "stellenbeschreibung",
    "aufgaben",
    "anforderungen",
    "wir suchen",
    "jetzt bewerben",
  ],
};
