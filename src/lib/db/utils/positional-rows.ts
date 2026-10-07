import { QueryError } from "../errors";
import type { DatabaseType } from "@/lib/types";

/**
 * Key each row a driver read positionally by the result's column names, one value per name, in order.
 *
 * `fields` are the names `uniqueFieldNames` gave the declared columns, so a repeated or unnamed column
 * lands under a name of its own instead of overwriting another column's value, which is what reading the
 * rows keyed by the declared names did.
 *
 * `Object.fromEntries` rather than assignment into a literal, because a column name is arbitrary SQL output
 * and `row["__proto__"] = v` replaces the prototype instead of adding a key.
 *
 * A row whose value count is not the column count is refused: padding or cutting it would show a value
 * under another column's name, and nothing downstream could tell.
 *
 * Server only, and it names no engine.
 */
export function keyRowsByPosition(
  fields: readonly string[],
  valueRows: readonly (readonly unknown[])[],
  provider: DatabaseType,
  sql: string,
): Record<string, unknown>[] {
  return valueRows.map((values, index) => {
    if (values.length !== fields.length) {
      throw new QueryError(
        `Row ${index + 1} carries ${values.length} values for ${fields.length} result columns`,
        provider,
        sql,
      );
    }
    return Object.fromEntries(fields.map((field, position) => [field, values[position]]));
  });
}
