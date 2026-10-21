import { isRecord } from "@/lib/is-record";
import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS, REDACTED_VALUE } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The fields of a MongoDB command whose top-level string values say what it runs on, kept as SQL keeps table names.
 * Anywhere else, and as any other type, a value is data.
 */
const MONGODB_NAME_FIELDS: ReadonlySet<string> = new Set(["collection", "operation", "database"]);

/**
 * A MongoDB command's shape: its keys and its top-level `collection`, `operation` and `database` names, every other
 * value replaced by `?`, as compact JSON. Text that is not one JSON document keeps nothing, since the provider does
 * not run it either.
 *
 * The document is walked with a stack of its own rather than by recursion: the text is the caller's, and `JSON.parse`
 * reads a document nested far deeper than a recursive walk can follow.
 */
function redactMongoCommand(text: string): string {
  let command: unknown;
  try {
    command = JSON.parse(text.trim());
  } catch {
    return REDACTED_VALUE;
  }
  const pieces: string[] = [];
  const pending: (string | { readonly value: unknown; readonly top: boolean })[] = [{ value: command, top: true }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === "string") {
      pieces.push(next);
      continue;
    }
    const { value, top } = next;
    if (Array.isArray(value)) {
      pending.push("]");
      for (let i = value.length - 1; i >= 0; i--) {
        pending.push({ value: value[i], top: false });
        if (i > 0) pending.push(",");
      }
      pending.push("[");
    } else if (isRecord(value)) {
      const fields = Object.entries(value);
      pending.push("}");
      for (let i = fields.length - 1; i >= 0; i--) {
        const [key, field] = fields[i];
        const named = top && MONGODB_NAME_FIELDS.has(key) && typeof field === "string";
        pending.push(named ? JSON.stringify(field) : { value: field, top: false });
        pending.push(`${JSON.stringify(key)}:`);
        if (i > 0) pending.push(",");
      }
      pending.push("{");
    } else {
      pieces.push(REDACTED_VALUE);
    }
  }
  return pieces.join("");
}

/** How MongoDB statement text is read: grammar, SQL text, redaction, update target and completion. */
export const MONGODB_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // MongoDB takes a JSON document, which is not SQL text, and never reaches the SQL readers on the QUERY path -
  // its provider extends `BaseDatabaseProvider` and never calls `prepareQuery`. It reaches the confirmation gate,
  // though, because both execution paths ask about whatever is in the editor before running it (#297).
  readsSqlText: false,
  // The JSON document the provider parses: its keys and the names it runs on are kept.
  redaction: { kind: "command", read: redactMongoCommand },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
