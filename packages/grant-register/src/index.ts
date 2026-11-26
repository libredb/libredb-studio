/**
 * The grant register: LibreDB's reviewed rows that grant an engine's claims (docs/providers/CONTRACT.md, clauses
 * M-54 and M-84).
 *
 * A row is keyed by the engine and either a package's name, version and digest or the legacy key `LEGACY_KEY`,
 * `@libredb/studio`, for an engine Studio still serves through its legacy adapter. A legacy row describes Studio's own
 * code, not a package, and is deleted as its engine moves into a package of its own.
 */

/** The key of a legacy row: the source name of Studio's legacy adapter. */
export const LEGACY_KEY = "@libredb/studio";
