/**
 * The agent's reader of one InfluxQL statement: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure, and safe in a browser bundle: it reads only the lexer and the read policy. It is the read policy
 * (`evaluateInfluxql`, the editor's own gate) and three refusals on top of it, each from the server's answers in
 * tests/fixtures/influxdb/1.13.1/agent-boundary/ and 2.9.1/agent-boundary/:
 *
 * - **No carriage return and no comment.** Both servers end a `--` comment at a lone `\r` and read what follows as a
 *   second statement, read a `\r` between two words as a space, and run a statement after a `/* *\/` comment
 *   (the `fence-*` captures). The lexer reads every one of those forms as the servers do, and an agent read has no use
 *   for any of them, so none is sent: no text whose reading depends on where a comment ends reaches the server.
 * - **SHOW of the catalog only.** A 1.13.1 user with READ on one database and that database as `db` is answered
 *   `SHOW QUERIES` with every running statement on the server, another user's text and name included, and
 *   `SHOW CONTINUOUS QUERIES` with the text an administrator wrote (`show-queries-during-admin-read-reader`,
 *   `show-continuous-queries-reader`). `SHOW USERS`, `GRANTS`, `STATS`, `DIAGNOSTICS`, `SHARDS`, `SHARD GROUPS` and
 *   `SUBSCRIPTIONS` read the server's administration and are answered to an administrator only. So the word after
 *   `SHOW` is one of `INFLUXQL_AGENT_SHOW_KINDS`, which read the databases, retention policies, measurements, series,
 *   tags and fields the principal may read, and their cardinality.
 * - **EXPLAIN of a SELECT only.** `EXPLAIN [ANALYZE] [VERBOSE]` before a `SELECT`; the policy also lets an `EXPLAIN`
 *   stand before a `SHOW`, which no agent read needs.
 *
 * Not the boundary. The boundary is the principal, proved read-only before every agent statement
 * (`influxql-agent-read.ts`); this is what lets the model read why it was refused, before anything is sent.
 */
import { type InfluxqlToken, lexInfluxql } from "./influxql-lexer";
import { evaluateInfluxql, type InfluxqlStatementKind } from "./influxql-policy";

export type InfluxqlAgentRefusalCode = "policy" | "carriage-return" | "comment" | "show-kind" | "explain-target";

export type InfluxqlAgentReading =
  | { readonly ok: true; readonly statement: InfluxqlStatementKind }
  | { readonly ok: false; readonly code: InfluxqlAgentRefusalCode; readonly message: string };

/** The word after `SHOW` in every catalog read an agent sends, its `CARDINALITY` forms included. */
export const INFLUXQL_AGENT_SHOW_KINDS: ReadonlySet<string> = new Set([
  "DATABASES",
  "RETENTION",
  "MEASUREMENTS",
  "MEASUREMENT",
  "SERIES",
  "TAG",
  "FIELD",
]);

export const INFLUXQL_AGENT_SENTENCES = {
  carriageReturn:
    "The statement holds a carriage return, which an agent read does not take: InfluxDB ends a -- comment at one and reads on past it. Write each line break as a plain newline. Nothing was sent.",
  comment: "The statement holds a comment, which an agent read does not take: remove it. Nothing was sent.",
  /** `word` is a folded keyword, "a quoted name", "a name", "a symbol" or "nothing", never user text. */
  showKind: (word: string): string =>
    `An agent read does not run SHOW ${word}: what it reads is the server's users, grants, running or continuous queries, or its internals. The SHOW reads an agent runs are DATABASES, RETENTION POLICIES, MEASUREMENTS, SERIES, TAG KEYS, TAG VALUES, FIELD KEYS and their CARDINALITY forms. Nothing was sent.`,
  /** `word` is a folded keyword, "a quoted name", "a name", "a symbol" or "nothing", never user text. */
  explainTarget: (word: string): string =>
    `An agent EXPLAIN explains a SELECT only, and this one is followed by ${word}. Nothing was sent.`,
} as const;

const isTrivia = (token: InfluxqlToken): boolean =>
  token.kind === "whitespace" || token.kind === "line-comment" || token.kind === "block-comment";

/** What a sentence calls a token: its folded keyword, or a class of token, never its text. */
function wordOf(token: InfluxqlToken | undefined): string {
  if (token === undefined || token.kind === "semicolon") return "nothing";
  if (token.kind === "keyword") return token.value as string;
  if (token.kind === "quoted-identifier") return "a quoted name";
  return token.kind === "identifier" ? "a name" : "a symbol";
}

const refuse = (code: InfluxqlAgentRefusalCode, message: string): InfluxqlAgentReading => ({
  ok: false,
  code,
  message,
});

/** One agent statement read: admitted with its kind, or refused with the sentence the model reads. */
export function readInfluxqlAgentStatement(text: string): InfluxqlAgentReading {
  if (text.includes("\r")) return refuse("carriage-return", INFLUXQL_AGENT_SENTENCES.carriageReturn);
  const verdict = evaluateInfluxql(text);
  if (!verdict.allowed) return refuse("policy", verdict.message);
  const tokens = lexInfluxql(text);
  if (tokens.some((token) => token.kind === "line-comment" || token.kind === "block-comment")) {
    return refuse("comment", INFLUXQL_AGENT_SENTENCES.comment);
  }
  const significant = tokens.filter((token) => !isTrivia(token));
  if (verdict.statement === "SHOW") {
    const kind = significant[1];
    if (kind?.kind !== "keyword" || !INFLUXQL_AGENT_SHOW_KINDS.has(kind.value as string)) {
      return refuse("show-kind", INFLUXQL_AGENT_SENTENCES.showKind(wordOf(kind)));
    }
  }
  if (verdict.statement === "EXPLAIN") {
    const explained = significant.find(
      (token, index) =>
        index > 0 && !(token.kind === "keyword" && (token.value === "ANALYZE" || token.value === "VERBOSE")),
    );
    if (explained?.kind !== "keyword" || explained.value !== "SELECT") {
      return refuse("explain-target", INFLUXQL_AGENT_SENTENCES.explainTarget(wordOf(explained)));
    }
  }
  return { ok: true, statement: verdict.statement };
}
