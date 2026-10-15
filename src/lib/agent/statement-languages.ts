/**
 * What the server does differently for each statement language agent mode reads in.
 *
 * Server only. `agent-manifest.ts` holds the facts a browser may read (which engine speaks which language, which
 * workflows a language offers, the copy the rail shows); this file holds the behaviour that must stay on the server:
 * the descriptor a model-written read is evaluated under, the repair ledger's identity of one call, and the advice a
 * refused read carries back. It reaches `node:crypto` through `repair-ledger.ts`, which is why it is a separate module
 * and why nothing a client component imports may reach it.
 *
 * The record is total over `AgentStatementLanguageId`, so a later language does not compile until it registers its
 * adapter here. A language id the record does not hold can still arrive from a ledger, and reaching one is a named
 * error rather than a quiet fall back to SQL: a statement fingerprinted as SQL, or refused with a SQL sentence, is a
 * wrong answer that looks like a right one.
 */
import { createHash } from "node:crypto";
import { admitKubectlStatement } from "@/lib/db/operations/kubectl-admission";
import { admitMongoStatement } from "@/lib/db/operations/mongo-admission";
import { readKubectlRun } from "@/lib/db/providers/platform/kubernetes/console/paging";
import type { AgentStatementLanguageId } from "./agent-manifest";
import { fingerprintStatement } from "./repair-ledger";

export interface AgentLanguageServerAdapter {
  /** The descriptor this language's model-written reads are evaluated under. */
  readonly readOperation: "sql.query.read" | "kubectl.query.read" | "mongo.query.read";
  /** Total over any text: the repair ledger's identity of one call. */
  readonly fingerprint: (text: string) => string;
  /** The sentence for a read refused past the row budget. */
  readonly rowCapAdvice: (statement: string, allowed: string) => string;
  /** The admission pre-check: the reader's own refusal, or null when admitted. Null for SQL, whose shape advice stays (D6). */
  readonly admit: ((text: string) => { readonly code: string; readonly message: string } | null) | null;
  /** The sentence a shape denial carries, in this language's words. Absent for SQL, whose sentence stays (D6). */
  readonly shapeAdvice?: string;
}

const SQL_ROW_CAP_ADVICE = (_statement: string, allowed: string) =>
  `Ask for fewer rows: add LIMIT ${allowed} (or an aggregate that returns one row) and run it again.`;

/** JSON with every object's keys in code-unit order, so two parses of one read serialise alike. */
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
 * Exported for its tests; the registry below is its production reader.
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
    `Ask for at most ${allowed} objects: name a namespace with -n, or narrow with -l or --field-selector, and run it again.`,
  top: (allowed: string) =>
    `Ask for at most ${allowed} pods: name a namespace with -n, or narrow with -l, and run it again.`,
  logs: (allowed: string) =>
    `Ask for at most ${allowed} lines: lower --tail, or name one container with -c, and run it again.`,
  events: (allowed: string) =>
    `Ask for at most ${allowed} events: name a namespace with -n, narrow with --for TYPE/NAME, or ask for --types Warning, and run it again.`,
});

/** The sentence for a kubectl read refused past the row budget. Exported for its tests, like the fingerprint. */
export function kubectlRowCapAdvice(statement: string, allowed: string): string {
  const run = readKubectlRun(statement);
  const advice = run.ok ? KUBECTL_ROW_CAP_ADVICE[run.statement.command] : undefined;
  return advice === undefined
    ? `Ask for at most ${allowed} rows: narrow the read to fewer objects, and run it again.`
    : advice(allowed);
}

/**
 * A MongoDB command's identity in the repair ledger: the envelope with every object's keys in code-unit order,
 * so `{"collection": "orders", "operation": "find"}` and `{"operation": "find", "collection": "orders"}` are ONE
 * read and two collections are two. Total: a line that does not parse is identified by its raw text, so a
 * refused line is still refused the second time. The fingerprint is taken over the text the pipeline carries
 * rather than over the object the model sent, so the ledger, the timeline and the editor hand-over - which all
 * carry text - agree with it by construction.
 *
 * Exported for its tests; the registry below is its production reader.
 */
export function fingerprintMongo(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return createHash("sha256").update(`mongo-raw:${text}`).digest("hex");
  }
  return createHash("sha256")
    .update(`mongo:${stableJson(parsed)}`)
    .digest("hex");
}

/**
 * The row-cap advice of the operations that read many documents, naming only what THAT operation narrows with:
 * a sentence that tells an aggregate to add a filter would name a key no stage carries. The keys are
 * `AGENT_LANGUAGE_COPY.mongo.adviceKeys`, and `statement-languages.test.ts` holds the two to each other.
 */
const MONGO_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  find: (allowed: string) =>
    `Ask for at most ${allowed} documents: narrow the filter, or set "options": {"limit": ${allowed}}, and run it again.`,
  aggregate: (allowed: string) =>
    `Ask for at most ${allowed} documents: add a $match stage before the $group, or a $limit stage, and run it again.`,
  count: (allowed: string) =>
    `A count answers one row: narrow the filter to the part of the data it is about, and run it again.`,
  distinct: (allowed: string) =>
    `Ask for at most ${allowed} values: narrow the filter to a smaller part of the collection, and run it again.`,
});

/** The sentence for a MongoDB read refused past the row budget. Exported for its tests, like the fingerprint. */
export function mongoRowCapAdvice(statement: string, allowed: string): string {
  let operation: string | undefined;
  try {
    const parsed = JSON.parse(statement.trim()) as Record<string, unknown>;
    if (typeof parsed.operation === "string") operation = parsed.operation;
  } catch {
    /* a line that does not parse gets the generic sentence */
  }
  const advice = operation === undefined ? undefined : MONGO_ROW_CAP_ADVICE[operation];
  return advice === undefined
    ? `Ask for at most ${allowed} rows: narrow the command to less of the collection, and run it again.`
    : advice(allowed);
}

const AGENT_LANGUAGE_SERVER: Readonly<Record<AgentStatementLanguageId, AgentLanguageServerAdapter>> = Object.freeze({
  sql: Object.freeze({
    readOperation: "sql.query.read",
    fingerprint: fingerprintStatement,
    rowCapAdvice: SQL_ROW_CAP_ADVICE,
    admit: null,
  }),
  kubectl: Object.freeze({
    readOperation: "kubectl.query.read",
    fingerprint: fingerprintKubectl,
    rowCapAdvice: kubectlRowCapAdvice,
    admit: admitKubectlStatement,
    shapeAdvice:
      "The statement's shape falls outside what a bounded read-only inspection may be, which is a decision about the contract rather than about a valid kubectl statement; a differently shaped read may still be admitted.",
  }),
  mongo: Object.freeze({
    readOperation: "mongo.query.read",
    fingerprint: fingerprintMongo,
    rowCapAdvice: mongoRowCapAdvice,
    admit: admitMongoStatement,
    shapeAdvice:
      "The command's shape falls outside the envelope a bounded read-only inspection may be, which is a decision about the contract rather than about a valid MongoDB read; a differently shaped command may still be admitted.",
  }),
} satisfies Record<AgentStatementLanguageId, AgentLanguageServerAdapter>);

/** The server adapter for `language`, or a named error when the id is not a language this server knows. */
export function languageServer(language: AgentStatementLanguageId): AgentLanguageServerAdapter {
  const adapter = Object.hasOwn(AGENT_LANGUAGE_SERVER, language) ? AGENT_LANGUAGE_SERVER[language] : undefined;
  if (adapter === undefined) throw new Error(`no server adapter for ${language}`);
  return adapter;
}
