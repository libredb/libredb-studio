import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS, REDACTED_VALUE } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { readRedisCommandText } from "./redis-command-text";

/** The JSON command form of a Redis statement, before the provider checks it. */
interface RedisJsonCommand {
  readonly command?: unknown;
  readonly args?: unknown;
}

/** A Redis command's name, upper-cased as the provider sends it, and one `?` for each of its arguments. */
function commandShape(command: string, argumentCount: number): string {
  return [command.toUpperCase(), ...Array.from({ length: argumentCount }, () => REDACTED_VALUE)].join(" ");
}

/**
 * A Redis command's shape: the name of the one command the provider would send, and a `?` for every argument, which
 * holds keys and values alike. A text that sends nothing (blank, only comments, a second command or an unclosed
 * quote) keeps nothing, and so does a JSON command the provider would refuse.
 */
function redactRedisCommand(text: string): string {
  const read = readRedisCommandText(text);
  if (read.kind === "plain") return commandShape(read.words[0], read.words.length - 1);
  if (read.kind !== "json") return REDACTED_VALUE;
  let parsed: RedisJsonCommand;
  try {
    // A JSON command is read only when its first character is `{`, so a body that parses is an object.
    parsed = JSON.parse(read.body) as RedisJsonCommand;
  } catch {
    return REDACTED_VALUE;
  }
  const { command, args } = parsed;
  if (typeof command !== "string" || command === "") return REDACTED_VALUE;
  if (args !== undefined && !Array.isArray(args)) return REDACTED_VALUE;
  return commandShape(command, args?.length ?? 0);
}

/** How Redis statement text is read: grammar, SQL text, redaction, update target and completion. */
export const REDIS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // Redis takes a command line, which is not SQL text, and never reaches the SQL readers on the QUERY path - its
  // provider extends `BaseDatabaseProvider` and never calls `prepareQuery`. It reaches the confirmation gate,
  // though, because both execution paths ask about whatever is in the editor before running it (#297).
  readsSqlText: false,
  // The one command `readRedisCommandText()` reads for the provider: its name is kept.
  redaction: { kind: "command", read: redactRedisCommand },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
