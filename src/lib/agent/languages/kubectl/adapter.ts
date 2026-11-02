/**
 * What the server does for a kubectl statement (#1821): the repair ledger's identity of one read, the row-cap advice
 * written in the command's own flags, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitKubectlStatement } from "@/lib/db/operations/kubectl-admission";
import { readKubectlRun } from "@/lib/db/providers/platform/kubernetes/console/paging";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * JSON with every object's keys in code-unit order, so the text does not depend on the order in which the parser
 * built the object's keys.
 *
 * kubectl's identity only, where key order carries no meaning: a kubectl flag map has none, and `readKubectlRun`
 * already builds one statement for `-n shop -l app=a` and `-l app=a -n shop`. A MongoDB command is never sorted (see
 * `canonicalMongoText` in `../mongo/adapter.ts`).
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

/**
 * A kubectl read's identity in the repair ledger: the parsed statement (command, flags by name with their values as
 * written, positional arguments in order) and its paging clause, so `-n shop` and `--namespace=shop` are one read and
 * `-n shop` and `-n web` are two. Total: a line that does not parse is identified by its raw text, so a refused line
 * is still refused the second time. Never the SQL tokenizer, which upper-cases words and reads `--x` as a comment.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintKubectl(text: string): string {
  const run = readKubectlRun(text);
  const canonical = run.ok
    ? `kubectl:${stableJson({ statement: run.statement, page: run.page ?? null })}`
    : `kubectl-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The row-cap advice of each command that reads many rows, naming only the flags that command takes: a sentence
 * that tells `logs` to add `-l` would send the model to a flag that reads more, not fewer. The keys are
 * `AGENT_LANGUAGE_COPY.kubectl.adviceKeys`, and `statement-languages.test.ts` holds the two to each other.
 */
const KUBECTL_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  get: (allowed: string) =>
    `Ask for at most ${allowed} object${allowed === "1" ? "" : "s"}: name a namespace with -n, or narrow with -l or --field-selector, and run it again.`,
  top: (allowed: string) =>
    `Ask for at most ${allowed} pod${allowed === "1" ? "" : "s"}: name a namespace with -n, or narrow with -l, and run it again.`,
  logs: (allowed: string) =>
    `Ask for at most ${allowed} line${allowed === "1" ? "" : "s"}: lower --tail, or name one container with -c, and run it again.`,
  events: (allowed: string) =>
    `Ask for at most ${allowed} event${allowed === "1" ? "" : "s"}: name a namespace with -n, narrow with --for TYPE/NAME, or ask for --types Warning, and run it again.`,
});

/** The sentence for a kubectl read refused past the row budget. Exported for its tests, like the fingerprint. */
export function kubectlRowCapAdvice(statement: string, allowed: string): string {
  const run = readKubectlRun(statement);
  const advice = run.ok ? KUBECTL_ROW_CAP_ADVICE[run.statement.command] : undefined;
  return advice === undefined
    ? `Ask for at most ${allowed} row${allowed === "1" ? "" : "s"}: narrow the read to fewer objects, and run it again.`
    : advice(allowed);
}

export const KUBECTL_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "kubectl.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintKubectl,
  rowCapAdvice: kubectlRowCapAdvice,
  admit: admitKubectlStatement,
  shapeAdvice:
    "The statement's shape falls outside what a bounded read-only inspection may be, which is a decision about the contract rather than about a valid kubectl statement; a differently shaped read may still be admitted.",
});
