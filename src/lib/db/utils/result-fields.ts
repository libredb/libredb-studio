/**
 * The columns of a result whose rows need not share one shape.
 *
 * A document store answers documents, and two documents of one collection may carry different keys. Taking
 * the columns from the first row drops every key only a later row carries: the grid shows no column for it,
 * and the CSV, SQL INSERT and DDL exports, which write `fields`, leave it out, while the JSON export keeps it.
 * The columns are therefore the union of the keys the rows carry, first seen first, so a result whose rows
 * do share one shape answers exactly the first row's keys in their order.
 *
 * One pass over every row's own keys, with a Set for membership: linear in the keys returned, so a wide
 * result of many documents costs what reading its keys costs.
 *
 * Server only, and it names no engine.
 */
export function unionFields(rows: readonly object[]): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) fields.add(key);
  }
  return [...fields];
}
