// Single source of truth for the status lifecycle. Imported by the popup;
// content/detect.js keeps its own inlined copy of ACTIVE_STATUSES since it
// can't use import (see the classic-script note at the top of that file).
export const STATUSES = [
  "Pending",
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Ghosted",
  "Ignored",
];

// Statuses for which the content script keeps asking for a status update on revisit.
export const ACTIVE_STATUSES = ["Applied", "Interview"];
