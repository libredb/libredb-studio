/**
 * The digest of an engine's statement language data, `statementLanguageData` of an engine declaration: the SHA-256, in
 * lower-case hex, of the data's canonical text (./canonical-json), the form the SQL grammar digest (./grammar-digest)
 * hashes too. A grant register row states the digest of the language data LibreDB reviewed, so that the grant
 * reader grants the language, and the claims that loosen the confirmation gate, only for the data that digests to it.
 * The server catalog's composer is the one module under src that imports it, to hand a package engine's digest to the
 * grant reader, and the repository's key command (scripts/providers-key.ts) prints it for a register row's author; a
 * legacy row states the digest of the data its declaration states, null for none, which the legacy request carries as
 * its row's own (tests/unit/db/grant-register-legacy-rows.test.ts holds the two equal).
 *
 * Server-only: it hashes with node:crypto. No module the browser loads imports it:
 * tests/unit/db/grammar-digest-boundary.test.ts holds the composer its one importer and the grant reader's value
 * imports free of it and of node:crypto.
 */
import { createHash } from "node:crypto";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { canonicalJsonText } from "./canonical-json";

/**
 * The canonical text of `data`.
 *
 * @throws {Error} Naming the type, for a value that is no JSON value anywhere in the data.
 */
export function canonicalLanguageDataText(data: NonNullable<StatementLanguageData>): string {
  return canonicalJsonText(data, "statement language");
}

/** The SHA-256 of `data`'s canonical text, 64 lower-case hex characters. */
export function languageDataSha256(data: NonNullable<StatementLanguageData>): string {
  return createHash("sha256").update(canonicalLanguageDataText(data)).digest("hex");
}
