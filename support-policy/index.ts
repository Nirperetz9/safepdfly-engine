// T104 — open-core blessed surface: host-side intake policy API.
//
// `support-policy` is pure host-side logic (no worker, no MuPDF at runtime —
// `dual-engine` only references the classifier's *types*). The proprietary
// feature layer drives intake through this barrel; it never imports the
// policy modules directly.
export * from "./reasons.js";
export * from "./budgets.js";
export * from "./dual-engine.js";
export * from "./page-kind.js";
export * from "./unsupported.js";
