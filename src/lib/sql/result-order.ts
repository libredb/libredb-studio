import type { DatabaseType } from "@/lib/types";
import { resolveSqlGrammar } from "./grammar";
import { readSqlSpan } from "./spans";
import { readSqlWord } from "./words";

/** Only an outer ORDER BY orders the result; literals, comments and inner/window sorts do not. */
export function hasResultOrder(sql: string, type?: DatabaseType): boolean {
  const grammar = resolveSqlGrammar(type);
  let depth = 0;
  let order = false;
  let i = 0;
  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span !== null) {
      if (!["whitespace", "line-comment", "block-comment"].includes(span.kind)) order = false;
      i = span.end;
      continue;
    }
    const word = readSqlWord(sql, i);
    if (word !== null) {
      if (depth === 0 && order && word.text === "BY") return true;
      order = depth === 0 && word.text === "ORDER";
      i = word.end;
      continue;
    }
    if (sql[i] === "(") depth++;
    if (sql[i] === ")") depth--;
    order = false;
    i++;
  }
  return false;
}
