/**
 * What this provider hands db2-node 1.0.22, made safe before the driver sees it (#786).
 *
 * Two defects of the driver are contained here, and both are about INPUT, which is why they
 * share a module: every statement and every parameter list the provider sends passes through
 * these two functions first, the catalog reads included.
 */

import { QueryError } from "../../../errors";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { fitsJavaScriptNumber } from "../sqlite-int64";

/** The `typeof` answers db2-node 1.0.22 binds, or refuses with an error a `catch` can see. */
const SCALAR_TYPES = new Set(["string", "number", "boolean", "undefined"]);

/**
 * The parameters with every `bigint` made bindable, or refused (M3).
 *
 * A JS `bigint` reaching db2-node 1.0.22 panics in its Rust code and aborts the whole process
 * with a core dump (K10): not a rejected promise, not an exception, nothing a `catch` can see.
 * So a bigint that a number represents exactly becomes that number, and any other is refused
 * here, naming the parameter and its value. There is no lossless way to bind one either: the
 * driver refuses a BIGINT bound as a string and rounds one bound as a number.
 *
 * Only a scalar or a byte buffer goes on. A bigint inside an array or an object aborts the
 * process the same way, and a `Date` or a `Map` is bound as the text `{}` with no error, so any
 * other parameter is refused here too (measured on 12.1.0.0).
 *
 * `undefined` stays `undefined`, so a statement with no parameters is sent with none rather
 * than with an empty list.
 */
export function normaliseParams(params?: unknown[]): unknown[] | undefined {
  if (params === undefined) return undefined;
  return params.map((value, index) => {
    if (typeof value === "bigint") {
      if (fitsJavaScriptNumber(value)) return Number(value);
      throw new QueryError(
        `Parameter ${index + 1} is a bigint outside the safe integer range (${value}); db2-node 1.0.22 cannot bind ` +
          "it losslessly and aborts the process on a bigint. Pass it as a string literal in the SQL instead.",
        "db2",
      );
    }
    if (value === null || value instanceof Uint8Array || SCALAR_TYPES.has(typeof value)) return value;
    const kind = Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`;
    throw new QueryError(
      `Parameter ${index + 1} is ${kind}; db2-node 1.0.22 binds only strings, numbers, booleans, null and byte ` +
        "buffers, and aborts the process on a bigint inside an array or an object. Pass each value as its own parameter.",
      "db2",
    );
  });
}

/** Leading trivia, as Db2's own grammar reads it: block comments nest there. */
const LEADING_TRIVIA = new Set(["whitespace", "line-comment", "block-comment"]);

/**
 * The statement with its leading comments removed.
 *
 * db2-node 1.0.22 refuses a statement that STARTS with a comment, block or line, with
 * SQLSTATE 42612 SQLCODE -84, while the same comment after the first keyword is accepted
 * (measured on 12.1.0.0). A comment above a statement is ordinary editor text, so the leading
 * run is dropped; nothing after the first token is touched.
 *
 * The run is read with Db2's grammar, so a nested block comment ends where Db2 ends it. A
 * comment that never closes, or a statement that is nothing but comments, is sent as written:
 * there is no statement to start, and the server's own answer is the honest one.
 */
export function driverStatement(sql: string): string {
  const grammar = resolveSqlGrammar("db2");
  let index = 0;
  let sawComment = false;
  for (;;) {
    const span = readSqlSpan(sql, index, grammar);
    if (span === null) break;
    if (!LEADING_TRIVIA.has(span.kind) || !span.terminated) return sql;
    if (span.kind !== "whitespace") sawComment = true;
    index = span.end;
  }
  if (!sawComment || index >= sql.length) return sql;
  return sql.slice(index);
}
