/**
 * The agent read-only execution profile's boundary on Apache Druid: the proof that the SQL endpoint runs the native
 * engine, sent at the open of a connection that will send statements and again before every agent statement, and the
 * fence every agent statement passes before it is sent.
 *
 * The boundary is the engine. Measured on Apache Druid 37.0.0 (`tests/fixtures/druid/37.0.0/agent-boundary/`), every
 * write on the SQL endpoint under the request context `engine: native` is refused by the server, whoever asks:
 * INSERT and REPLACE in every spelling are refused as operations the native engine does not support, an INSERT into
 * EXTERN (an export) included; UPDATE, DELETE and MERGE are unsupported statements; CREATE, DROP, ALTER and TRUNCATE
 * are not in the grammar; and a SELECT that reads EXTERN cannot be planned on the native engine (captures 01 and 06).
 * Under druid-basic-security the refusals are the same for a user holding WRITE on every datasource and for the
 * administrator, while the same INSERT through the MSQ task endpoint, which the provider never calls, writes (capture
 * 06). No least-privilege principal can be proven: a user reads its own permissions only when it holds CONFIG READ,
 * which also shows it every user's credential hash (capture 05), so the boundary rests on the engine, never the user.
 *
 * What would move the engine is the statement or the request: `SET engine = 'msq-task'` before a statement, or the
 * request context's own engine, selects another engine, and a SET also replaces the request's query id and timeout
 * (capture 01). Druid 37 refuses msq-task on this endpoint, but the provider does not lean on that. The request
 * context is written by the transport and never by the caller, and the fence below sends only a statement whose first
 * keyword is SELECT or WITH, so no SET reaches the server.
 *
 * The proof (`verifyDruidAgentEngine`) sends one INSERT into a datasource whose name carries a fresh random suffix,
 * under the agent request's own context, and admits the server only when it answers the native engine's own refusal,
 * category INVALID_INPUT and those exact words. A server that ran the INSERT does not enforce the engine; any other
 * answer is one this check has not measured; both refuse the profile. A failure to reach the server leaves as it came.
 */
import { ExecutionProfileError } from "../../../errors";
import { hasLoneCarriageReturnInLineComment, readSqlSpan } from "@/lib/sql/spans";
import { DRUID_SQL_GRAMMAR } from "./sql-grammar";
import { type DruidQueryResult, DruidTransportError } from "./transport";

/** Sends one statement under the agent request's context and answers its result, or throws the server's refusal. */
export type DruidAgentProbe = (sql: string) => Promise<DruidQueryResult>;

/** The native engine's refusal of an INSERT, word for word as Druid 37.0.0 answers it (captures 01 and 06). */
const NATIVE_INSERT_REFUSAL =
  "INSERT operations are not supported by requested SQL engine [native], consider using MSQ.";

/** What every refusal of the check starts with. */
const NEEDS_NATIVE =
  "The agent read-only execution profile needs the Druid SQL endpoint's native engine, which refuses every INSERT";

/** The probe: an INSERT into one datasource named with a fresh suffix, which no one holds. */
export function druidAgentProbeStatement(nonce: string): string {
  return `INSERT INTO "libredb_agent_probe_${nonce}" SELECT TIME_PARSE('2026-01-01') AS __time PARTITIONED BY ALL`;
}

/**
 * The proof that the endpoint runs the native engine: `probe` sends the INSERT, which the server must refuse with the
 * native engine's own refusal. Resolves when it does; refuses the profile on any other answer.
 */
export async function verifyDruidAgentEngine(probe: DruidAgentProbe, nonce: string): Promise<void> {
  try {
    await probe(druidAgentProbeStatement(nonce));
  } catch (error) {
    if (!(error instanceof DruidTransportError) || !error.isServerAnswer()) throw error;
    if (error.is("INVALID_INPUT") && error.message === NATIVE_INSERT_REFUSAL) return;
    throw new ExecutionProfileError(
      `${NEEDS_NATIVE}; this server answered the probe with ${JSON.stringify(error.message)}, which is not that refusal, so its enforcement is unmeasured, and the connection is refused.`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  throw new ExecutionProfileError(
    `${NEEDS_NATIVE}; this server ran one, so it does not enforce it, and the connection is refused.`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/** What every fence refusal starts with. */
const FENCE =
  "The agent read-only execution profile sends one Druid SQL statement, a SELECT (a WITH before it is fine), and nothing else";

/** The statement's first keyword, read from its first code character, case aside and not a longer word. */
const FIRST_KEYWORD = /^(?:select|with)(?![\w$])/i;

/**
 * The fence in front of every agent statement: `null` when `sql` is one statement whose first keyword is SELECT or
 * WITH, else the reason it is refused, before anything is sent. A SET before a statement selects another engine and
 * replaces the request's query id and timeout (capture 01), so only a SELECT is sent.
 *
 * The text is walked with the shared span reader under Druid's own grammar (`sql-grammar.ts`), so `--`, `//` and
 * block comments and whitespace are skipped, and string literals and double-quoted names are opaque. The first code
 * character must open SELECT or WITH; a code semicolon ends the statement, and only comments and whitespace may follow
 * it. A hint (`/*+ ... *\/`) and an array's brackets are read as code, a literal inside them still opaque, so a
 * semicolon there ends the statement too. Text that ends inside a comment, string or quoted name cannot be bounded and
 * is refused: that includes a plain literal ending in a backslash, which Druid closes and the reader cannot place
 * (capture 02), so it refuses rather than guesses.
 *
 * Two readings where the server and a reader can differ are refused before the walk. A carriage return inside a `--`
 * or `//` comment with more text after it ends the comment on the server (capture 02), as it does in the grammar the
 * walk reads, but a reader that runs the comment on to the line feed reads a different statement. And a `$$` run is a
 * string to the reader but part of a name to Druid, which reads `$` as a letter (capture 02), so a comment inside it is
 * code to one and text to the other. A form feed, U+2028 and U+0085 end no comment on the server.
 */
export function druidAgentStatementRefusal(sql: string): string | null {
  const grammar = DRUID_SQL_GRAMMAR.grammar;
  if (hasLoneCarriageReturnInLineComment(sql, grammar)) {
    return `${FENCE}; this text holds a carriage return inside a -- or // comment with more text after it, and the server ends the comment at that carriage return, so a reader that does not could read another statement, and it was not sent. End a comment with a line feed.`;
  }
  let opened = false;
  let ended = false;
  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (!span.terminated) {
        return `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`;
      }
      const trivia = span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment";
      if (!trivia) {
        if (!opened) return notSelect();
        if (ended) return goesOn();
        if (span.kind === "dollar-string") {
          return `${FENCE}; this text holds a dollar-quoted run ($$ ... $$), which Druid reads as part of a name rather than as a string, so where its comments end cannot be read, and it was not sent.`;
        }
      }
      at = span.end;
      continue;
    }
    if (ended) return goesOn();
    if (!opened) {
      if (!FIRST_KEYWORD.test(sql.slice(at, at + 7))) return notSelect();
      opened = true;
    }
    if (sql[at] === ";") ended = true;
    at++;
  }
  return opened ? null : `${FENCE}; this text holds no statement, so nothing was sent.`;
}

function notSelect(): string {
  return `${FENCE}; this statement does not begin with SELECT or WITH, so it was not sent. A SET before a statement changes the request's own context, the engine and the query id among them, so only a SELECT reaches the server.`;
}

function goesOn(): string {
  return `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`;
}
