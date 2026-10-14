/**
 * What the server does differently for each statement language agent mode reads in.
 *
 * Server only. `agent-manifest.ts` holds the facts a browser may read (which engine speaks which language, which
 * workflows a language offers, the copy the rail shows); this file holds the behaviour that must stay on the server:
 * the descriptor a model-written read is evaluated under, the repair ledger's identity of one call, and the advice a
 * refused read carries back. It reaches `node:crypto` through `repair-ledger.ts`, which is why it is a separate module
 * and why nothing a client component imports may reach it.
 *
 * A later language registers its adapter here, keyed by its `AgentStatementLanguageId`. Until it does, a run recorded
 * in that language has no adapter, and reaching one is a named error rather than a quiet fall back to SQL: a kubectl
 * statement fingerprinted as SQL, or refused with a SQL sentence, is a wrong answer that looks like a right one.
 */
import type { AgentStatementLanguageId } from "./agent-manifest";
import { fingerprintStatement } from "./repair-ledger";

export interface AgentLanguageServerAdapter {
  /** The descriptor this language's model-written reads are evaluated under. */
  readonly readOperation: "sql.query.read" | "kubectl.query.read";
  /** Total over any text: the repair ledger's identity of one call. */
  readonly fingerprint: (text: string) => string;
  /** The sentence for a read refused past the row budget, or undefined to fall through. */
  readonly rowCapAdvice: (statement: string, allowed: string) => string;
  /** The admission pre-check: the reader's own refusal, or null when admitted. Null for SQL, whose shape advice stays (D6). */
  readonly admit: ((text: string) => { readonly code: string; readonly message: string } | null) | null;
}

const AGENT_LANGUAGE_SERVER: Readonly<Partial<Record<AgentStatementLanguageId, AgentLanguageServerAdapter>>> =
  Object.freeze({
    sql: Object.freeze({
      readOperation: "sql.query.read",
      fingerprint: fingerprintStatement,
      rowCapAdvice: (_statement: string, allowed: string) =>
        `Ask for fewer rows: add LIMIT ${allowed} (or an aggregate that returns one row) and run it again.`,
      admit: null,
    }),
  } satisfies Partial<Record<AgentStatementLanguageId, AgentLanguageServerAdapter>>);

/** The server adapter for `language`, or a named error when that language has none registered yet. */
export function languageServer(language: AgentStatementLanguageId): AgentLanguageServerAdapter {
  const adapter = Object.hasOwn(AGENT_LANGUAGE_SERVER, language) ? AGENT_LANGUAGE_SERVER[language] : undefined;
  if (adapter === undefined) throw new Error(`no server adapter for ${language}`);
  return adapter;
}
