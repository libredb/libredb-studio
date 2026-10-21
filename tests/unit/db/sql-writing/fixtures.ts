/**
 * The literal, identifier and placeholder output of every engine, rendered as text.
 *
 * This is the golden that the SQL writing contract move is measured against: it calls
 * only today's public functions, so a file under `golden/` records what the tree
 * answered before any per-engine module existed, and a diff in one is a behaviour
 * change. The isolation test reuses `renderGolden` to prove that one engine's row
 * cannot move another engine's output. The inline edit lines come next, from
 * `renderInlineEditGolden`, and the SQL export lines last, from `renderExportGolden`.
 *
 * Four keys are not engines. `no-connection` is the generator that has no connection
 * to name a dialect, so it renders `undefined`. `empty-string` renders `""`, which a
 * published component's `databaseType?: string` can carry and which every writer read as
 * no connection before the contract. `constructor` and `not-an-engine` reach
 * the functions as raw strings, the way `QuerySafetyDialog` can hand one over through
 * its `databaseType?: string`: today `constructor` resolves to an `Object.prototype`
 * member in a plain lookup table, and the golden pins whatever that answers.
 */
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { positionalPlaceholder, quoteLiteral, temporalLiteral, unquoteLiteral } from "@/lib/sql/values";
import type { DatabaseType } from "@/lib/types";
import { renderExportGolden } from "./export-fixtures";
import { renderInlineEditGolden } from "./inline-edit-fixtures";

export const GOLDEN_KEYS: readonly string[] = Object.freeze([
  ...EXTERNAL_DATABASE_TYPES,
  "libredb",
  "no-connection",
  "empty-string",
  "constructor",
  "not-an-engine",
]);

/** The trailing backslash, the lone quote, NUL, newline and a non-Latin-1 name are the escape edges. */
export const LITERAL_VALUES = ["", "it's", "a\\b", "a\\", "'", "a\\'b", "Müşteri", "x\u0000y", "line\nbreak"];

/** Literal texts as a catalog reports them, each read by one dialect's rules and not another's. */
export const RAW_LITERALS = ["'a''b'", "'a\\'b'", "N'x'", "'open", "'a'b'"];

export const IDENTIFIER_NAMES = ["plain", 'x"y', "a`b", "a]b", "a\\b"];

/** Two digits is where a placeholder spelled by string surgery would go wrong. */
export const PLACEHOLDER_POSITIONS = [1, 2, 10];

const TEMPORAL_VALUES: ReadonlyArray<readonly [string, "date" | "timestamp"]> = [
  ["2026-01-27", "date"],
  ["2026-01-27 14:30:00", "timestamp"],
  ["2026-01-27T14:30:00Z", "timestamp"],
  ["27-JAN-26", "date"],
];

const show = (value: unknown): string => (value === undefined ? "undefined" : JSON.stringify(value));

export async function renderGolden(type: string | undefined): Promise<string> {
  const dialect = type as DatabaseType | undefined;
  const lines: string[] = [];
  const line = (call: string, result: unknown) => lines.push(`${call} => ${show(result)}`);
  const t = show(type);

  for (const value of LITERAL_VALUES) {
    const quoted = quoteLiteral(value, dialect);
    line(`quoteLiteral(${show(value)}, ${t})`, quoted);
    line(`unquoteLiteral(quoteLiteral(${show(value)}, ${t}), ${t})`, unquoteLiteral(quoted, dialect));
  }
  for (const raw of RAW_LITERALS) {
    line(`unquoteLiteral(${show(raw)}, ${t})`, unquoteLiteral(raw, dialect));
  }
  for (const name of IDENTIFIER_NAMES) {
    line(`quoteIdentifier(${show(name)}, ${t})`, quoteIdentifier(name, dialect));
  }
  // `positionalPlaceholder` takes a `DatabaseType`, so the no-connection key has no call to make.
  if (dialect !== undefined) {
    for (const position of PLACEHOLDER_POSITIONS) {
      line(`positionalPlaceholder(${t}, ${position})`, positionalPlaceholder(dialect, position));
    }
  }
  for (const [value, kind] of TEMPORAL_VALUES) {
    line(`temporalLiteral(${show(value)}, ${show(kind)}, ${t})`, temporalLiteral(value, kind, dialect));
  }
  return `${lines.join("\n")}\n${await renderInlineEditGolden(type)}\n${renderExportGolden(type)}`;
}

/** The golden file name of a key. */
export function goldenFileName(key: string): string {
  return `${key}.txt`;
}
