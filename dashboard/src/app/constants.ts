// Mirrors shared/constants.js's STATUSES — duplicated natively rather than
// imported for the same allowJs: false reason as applications-service.ts.
// Keep in sync by hand if the status list changes.
export const STATUSES = ['Pending', 'Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn', 'Ghosted', 'Ignored'];

// Single source of truth for per-status color, shared by stats-flow.ts, the
// board/list views, and any badge/pill anywhere else in the dashboard — so
// "Interview" (say) is always the same blue everywhere instead of each
// component picking its own. Values are the dataviz skill's documented,
// pre-validated palette steps (see stats-flow.ts's original comment) — not
// eyeballed, and not to be changed without re-running that skill's
// validator. Pending/Applied/Interview are an ORDINAL sequence (one hue,
// monotone lightness — "how far along, not yet judged"); Offer/Rejected/
// Ghosted are STATUS colors (a real good/bad judgment applies);
// Withdrawn/Ignored are neutral ink (a user-driven closure, not a judged
// outcome).
export const STATUS_COLORS: Record<string, string> = {
  Pending: '#86b6ef', // ordinal step 250 (lightest allowed, light mode)
  Applied: '#3987e5', // ordinal step 400
  Interview: '#1c5cab', // ordinal step 550 (furthest along, still undecided)
  Offer: '#0ca30c', // status: good
  Rejected: '#d03b3b', // status: critical
  Ghosted: '#ec835a', // status: serious
  Withdrawn: '#898781', // neutral ink — user's own choice, not a judged outcome
  Ignored: '#898781', // neutral ink — same reasoning
};
