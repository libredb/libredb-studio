/**
 * What the server does for a LibreDB read command: the repair ledger's identity of one read, the row-cap advice in the
 * command's own words, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitLibredbkvStatement } from "@/lib/db/operations/libredbkv-admission";
import { readLibreDBReadCommand } from "@/lib/db/providers/embedded/libredb-command";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A LibreDB read's identity in the repair ledger: the parsed command, so `GET users:1` and `get "users:1"` are one read
 * and `get users:1` and `get users:2` are two. Total: a command that does not parse is identified by its raw text, so
 * a refused command is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintLibredbkv(text: string): string {
  const reading = readLibreDBReadCommand(text);
  const canonical = reading.ok ? `libredbkv:${JSON.stringify(reading.command)}` : `libredbkv-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The row-cap advice of each command that reads many keys. `get` reads one key at most, so it has none. The keys are
 * the language copy's `adviceKeys`, and `statement-languages.test.ts` holds the two to each other.
 */
const LIBREDBKV_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  prefix: (allowed: string) =>
    `Ask for at most ${allowed} keys: lengthen the prefix to a narrower one, or read a range, and run it again.`,
  range: (allowed: string) =>
    `Ask for at most ${allowed} keys: bring the start and the end of the range closer together, and run it again.`,
});

/** The sentence for a LibreDB read refused past the row budget. Exported for its tests, like the fingerprint. */
export function libredbkvRowCapAdvice(statement: string, allowed: string): string {
  const reading = readLibreDBReadCommand(statement);
  const advice = reading.ok ? LIBREDBKV_ROW_CAP_ADVICE[reading.command.verb] : undefined;
  return advice === undefined
    ? `Ask for at most ${allowed} keys: narrow the read to fewer keys, and run it again.`
    : advice(allowed);
}

export const LIBREDBKV_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "libredbkv.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintLibredbkv,
  rowCapAdvice: libredbkvRowCapAdvice,
  admit: admitLibredbkvStatement,
  shapeAdvice:
    "The command's shape falls outside what a bounded read-only read may be, which is a decision about the contract rather than about a valid LibreDB command; a differently shaped read may still be admitted.",
});
