// src/exports/security.ts
//
// Standalone subpath, following the workspace.ts precedent: it is deliberately NOT re-exported
// from src/exports/index.ts, so a consumer of the base package does not pull in header logic.
//
// The package ships the knowledge; the application ships the enforcement. Studio's own headers are
// set by src/proxy.ts. libredb-platform supplies its own backend and its own next.config, so it
// adopts the same policy by spreading securityHeaders() rather than by inheriting any Studio code.
export { HSTS_MAX_AGE_SECONDS, securityHeaders, studioCspDirectives } from "../lib/security/headers";
export type { CspDirectives, CspOptions, SecurityHeaderOptions } from "../lib/security/headers";
