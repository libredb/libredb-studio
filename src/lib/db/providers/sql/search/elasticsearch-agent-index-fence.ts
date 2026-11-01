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
 *  - a statement whose quote or comment never closes, since where its names end cannot be read; the grammar row reads
 *    a backslash as the engine does, an ordinary character in both quotes, so no quote's end is a guess;
 *  - an empty quoted name, which the engine reads as every open index, and which before a `.` would start the name
 *    after it with a dot;
 *  - a name that starts with a dot, read as the engine builds it: the quoted and bare names of one reference joined by
 *    their `.`, and a `.` written as `%2E` or `\u002E` in a quoted name read as a dot; and a `.` inside a quoted name
 *    after any character but a letter, a digit or `_`, which starts one index of a comma list, an exclusion, an
 *    inclusion, date math or a remote cluster's index;
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

export const EMPTY_NAME_REFUSAL =
  "The agent names nothing in Elasticsearch with an empty quoted name: the engine reads an empty index name as every open index, and an empty name before a `.` would start the name after it with a dot";

export const UNREADABLE_REFUSAL =
  "The agent sends Elasticsearch no statement whose quote or comment never closes, since where its names end cannot be read";

export const CATALOG_COMMAND_REFUSAL =
  "The agent sends Elasticsearch no SHOW, DESCRIBE, SYS or DEBUG command but its own column catalog read, SYS COLUMNS for every table or for one: the others take an index pattern as a string, which the agent does not read as an index name";

/** One token of a statement's code: a word, a quoted name with its text, a string, a qualifying `.`, or else. */
type Token =
  | { readonly kind: "word" | "quoted"; readonly text: string }
  | { readonly kind: "dot" | "string" | "other" };

const WORD_AT = /[A-Za-z0-9_]+/y;
/** A `.` inside a quoted name after anything but a letter, a digit or `_`: the start of one name of an expression. */
const DOT_AFTER_NON_NAME = /[^A-Za-z0-9_]\./;
/** A `.` written as an escape the engine never decodes; read as a dot all the same, since no index name holds one. */
const ENCODED_DOT = /%2e|\\u002e/gi;
/** What may stand right before a `.` in code that qualifies a name: a name's last character, or a closing quote. */
const QUALIFIES = /[A-Za-z0-9_"\]]/;
const DIGIT = /[0-9]/;
/** The commands that read the catalog; `DESC` is also `ORDER BY`'s word, so only a leading one is a command. */
const COMMANDS = new Set(["SHOW", "DESCRIBE", "SYS", "DEBUG"]);

const refuse = (sentence: string, sql: string) => new RefusedBeforeSendError(sentence, "elasticsearch", sql);

/**
 * The statement's code as tokens, read with the Elasticsearch grammar row: whitespace and comments dropped, a string
 * one opaque token, a quoted name its text. A run that never closes, and a `.` that starts a name in code, are refused
 * here, where the span and the character before the `.` are known.
 */
function tokens(sql: string): Token[] {
  const grammar = resolveSqlGrammar("elasticsearch");
  const found: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, grammar);
    if (span !== null) {
      if (!span.terminated) throw refuse(UNREADABLE_REFUSAL, sql);
      if (span.kind === "quoted-identifier") {
        found.push({ kind: "quoted", text: sql.slice(index + 1, span.end - 1).replace(ENCODED_DOT, ".") });
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
    const ch = sql[index];
    if (ch === "." && !QUALIFIES.test(sql[index - 1] ?? "") && !DIGIT.test(sql[index + 1] ?? "")) {
      throw refuse(DOT_INDEX_REFUSAL, sql);
    }
    found.push({ kind: ch === "." ? "dot" : "other" });
    index++;
  }
  return found;
}

/**
 * Each name the statement writes, as the engine builds it: a run of quoted and bare names joined by `.`, whitespace
 * and comments between them dropped, the quotes stripped.
 */
function references(read: readonly Token[]): string[] {
  const built: string[] = [];
  let joined = false;
  let open = false;
  for (const token of read) {
    if (token.kind === "word" || token.kind === "quoted") {
      if (joined) built[built.length - 1] += `.${token.text}`;
      else built.push(token.text);
      open = true;
      joined = false;
    } else {
      joined = open && !joined && token.kind === "dot";
      open = joined;
    }
  }
  return built;
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

/**
 * Refuses a statement whose text cannot be read to its end, that writes an empty quoted name, names a hidden or system
 * index, or sends a catalog command but the agent's own.
 */
export function assertAgentIndexNames(sql: string): void {
  const read = tokens(sql);
  if (read.some((token) => token.kind === "quoted" && DOT_AFTER_NON_NAME.test(token.text))) {
    throw refuse(DOT_INDEX_REFUSAL, sql);
  }
  // First, so an empty name before a `.` (`"".security`) is answered as the dot-led name the engine builds of it.
  if (references(read).some((name) => name.startsWith("."))) throw refuse(DOT_INDEX_REFUSAL, sql);
  if (read.some((token) => token.kind === "quoted" && token.text === "")) throw refuse(EMPTY_NAME_REFUSAL, sql);
  const first = read[0];
  const command =
    (first?.kind === "word" && first.text === "DESC") ||
    read.some((token) => token.kind === "word" && COMMANDS.has(token.text));
  if (command && !isColumnCatalogRead(read)) throw refuse(CATALOG_COMMAND_REFUSAL, sql);
}
