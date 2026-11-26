import { isRecord } from "@/lib/is-record";
import { REDACTED_VALUE } from "@/lib/db/sql-grammar/shared";
import type { CommandRedactionReader } from "@/lib/db/sql-grammar/types";

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
 *
 * MongoDB's command redaction reader, the `redactionReader` the engine's granted redaction names, bound by Studio's
 * grammar function table (src/lib/db/sql-grammar/index.ts, `SQL_GRAMMAR_FUNCTIONS`).
 */
export const MONGODB_REDACTION_READER: CommandRedactionReader = function redactMongoCommand(text: string): string {
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
};
