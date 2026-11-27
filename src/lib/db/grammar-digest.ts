/**
 * The digest of a SQL grammar, `sqlText.grammar` of an engine declaration: the SHA-256, in lower-case hex, of the
 * grammar's canonical text. A grant register row states the digest of the grammar LibreDB reviewed the engine's SQL
 * text claims with, its `grammarSha256`, and the grant reader (./claim-grants) grants those claims only where the
 * digest of the grammar an engine declares is that one.
 *
 * The canonical text is the grammar as JSON with no white space, every object's members in ascending code-unit order
 * and every list in its own order (./canonical-json, which the statement language data digest, ./language-digest,
 * reads too), so two declarations stating the same facts in another member order have one digest and any changed fact
 * another.
 *
 * Server-only: it hashes with node:crypto. The server catalog's composer (./server-catalog-compose) computes a provider
 * package's grammar digest here when it grants the package's engine; a legacy engine's request carries its legacy
 * row's digest, which tests/unit/db/grant-register-legacy-rows.test.ts holds equal to the digest of its declaration's
 * grammar computed here. No module the browser loads imports it: tests/unit/db/grammar-digest-boundary.test.ts holds
 * the composer the one module of src that imports it, directly or by a re-export, and the grant reader's value imports
 * free of it and of node:crypto.
 */
import { createHash } from "node:crypto";
import { canonicalJsonText } from "./canonical-json";

/**
 * The canonical text of `grammar`.
 *
 * @throws {Error} Naming the type, for a value that is no JSON value: `undefined`, a function, a symbol, a bigint or a
 * number that is not finite, anywhere in the grammar.
 */
export function canonicalGrammarText(grammar: unknown): string {
  return canonicalJsonText(grammar, "grammar");
}

/** The SHA-256 of `grammar`'s canonical text, 64 lower-case hex characters. */
export function grammarSha256(grammar: unknown): string {
  return createHash("sha256").update(canonicalGrammarText(grammar)).digest("hex");
}
