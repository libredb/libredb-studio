/**
 * The Elasticsearch agent path's index-name fence: which indices an agent statement may name, read before it is sent.
 *
 * The boundary of the agent read-only profile here is the grammar of the SQL endpoint, which holds no write, and the
 * login's privileges, which no check at open narrows. Measured on 9.1.4 on 2026-11-01, signed in as the superuser,
 * every hidden and system index answers its rows through SQL when a statement names it with a leading dot: the
 * security index (`".security"`, `".security-7"`, `".sec*"`, `"probe_orders,.security-7"`, `"<.security-7>"`), the
 * deprecation log data stream and its backing index. A wildcard that does not start with a dot (`"*"`, `"*security*"`)
 * reaches no hidden index, an unquoted name cannot start with a dot, a string is never read as an index name in a
 * `SELECT`, and a restricted index cannot be given an alias, so every way a statement reaches one of them writes a dot
 * at the start of a name, a name inside a quoted index expression, or a `LIKE` pattern of a catalog command.
 *
 * So the fence refuses, before anything is sent:
 *
 *  - a `.` in a quoted name that starts the name or follows any character but a letter, a digit or `_` (the start of
 *    one index of a comma list, a date-math expression, an exclusion or a remote cluster's index);
 *  - a `.` in code that follows any character but a letter, a digit, `_` or a closing quote, unless a digit follows it
 *    (`.5` is a number);
 *  - every `SHOW`, `DESCRIBE`, `SYS` and `DEBUG` command, and a leading `DESC`, but the column catalog read the agent
 *    composes (`SYS COLUMNS`, for every table or for one quoted table): the other commands take a `LIKE` pattern as a
 *    string, which this fence does not read as a name.
 *
 * A data stream is read by its own name, which names no hidden backing index. Text is read with the engine's grammar
 * row, so a comment or a string hides nothing the engine reads as code. Parser-side defence on top of the engine's
 * refusal of every write: no index is withheld from a login by it, only the hidden and system ones by their names.
 * Raised as `RefusedBeforeSendError`, since the statement is never sent.
 */
import { RefusedBeforeSendError } from "@/lib/db/errors";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";

export const DOT_INDEX_REFUSAL =
  "The agent names no Elasticsearch index that starts with a dot: those are the hidden and system indices, the security index among them, which a login that may read them reads through SQL; read a data stream by its own name rather than its backing index";

export const CATALOG_COMMAND_REFUSAL =
  "The agent sends Elasticsearch no SHOW, DESCRIBE, SYS or DEBUG command but its own column catalog read, SYS COLUMNS for every table or for one: the others take an index pattern as a string, which the agent does not read as an index name";

/** One token of a statement's code: a word, a quoted name with its text, a string, or anything else. */
type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "quoted"; readonly text: string }
  | { readonly kind: "string" | "other" };

const WORD_AT = /[A-Za-z0-9_]+/y;
/** A `.` that starts a name inside a quoted name: at its start, or after anything but a letter, a digit or `_`. */
const NAME_STARTS_WITH_DOT = /(?:^|[^A-Za-z0-9_])\./;
/** What may stand right before a `.` in code that qualifies a name: a name's last character, or a closing quote. */
const QUALIFIES = /[A-Za-z0-9_"\]]/;
const DIGIT = /[0-9]/;
/** The commands that read the catalog; `DESC` is also `ORDER BY`'s word, so only a leading one is a command. */
const COMMANDS = new Set(["SHOW", "DESCRIBE", "SYS", "DEBUG"]);

/**
 * The statement's code as tokens, read with the Elasticsearch grammar row: whitespace and comments dropped, a string
 * one opaque token, a quoted name its text. A `.` that starts a name in code is refused here, where the character
 * before it is known.
 */
function tokens(sql: string): Token[] {
  const grammar = resolveSqlGrammar("elasticsearch");
  const found: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, grammar);
    if (span !== null) {
      if (span.kind === "quoted-identifier") {
        found.push({ kind: "quoted", text: sql.slice(index + 1, span.end - 1) });
      } else if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") {
        found.push({ kind: "string" });
      }
      index = span.end;
      continue;
    }
    WORD_AT.lastIndex = index;
    const word = WORD_AT.exec(sql)?.[0];
    if (word !== undefined) {
      found.push({ kind: "word", text: word.toUpperCase() });
      index += word.length;
      continue;
    }
    if (sql[index] === "." && !QUALIFIES.test(sql[index - 1] ?? "") && !DIGIT.test(sql[index + 1] ?? "")) {
      throw new RefusedBeforeSendError(DOT_INDEX_REFUSAL, "elasticsearch", sql);
    }
    found.push({ kind: "other" });
    index++;
  }
  return found;
}

/** The column catalog read the agent composes: `SYS COLUMNS`, alone or with one quoted table. */
function isColumnCatalogRead(read: readonly Token[]): boolean {
  const [sys, columns, table, ...rest] = read;
  return (
    sys?.kind === "word" &&
    sys.text === "SYS" &&
    columns?.kind === "word" &&
    columns.text === "COLUMNS" &&
    (table === undefined || table.kind === "quoted") &&
    rest.length === 0
  );
}

/** Refuses a statement that names a hidden or system index, or sends a catalog command but the agent's own. */
export function assertAgentIndexNames(sql: string): void {
  const read = tokens(sql);
  if (read.some((token) => token.kind === "quoted" && NAME_STARTS_WITH_DOT.test(token.text))) {
    throw new RefusedBeforeSendError(DOT_INDEX_REFUSAL, "elasticsearch", sql);
  }
  const first = read[0];
  const command =
    (first?.kind === "word" && first.text === "DESC") ||
    read.some((token) => token.kind === "word" && COMMANDS.has(token.text));
  if (command && !isColumnCatalogRead(read)) {
    throw new RefusedBeforeSendError(CATALOG_COMMAND_REFUSAL, "elasticsearch", sql);
  }
}
