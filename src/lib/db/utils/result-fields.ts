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

/** The name a column the driver declares with no name is shown and keyed under, as SQL Server's own tools word it. */
export const UNNAMED_FIELD = "(No column name)";

/**
 * The names a result's columns are keyed under, one per declared column, in order: each non-empty and
 * different from every other, which is what `QueryResult.fields` promises.
 *
 * A driver may declare a column with no name (SQL Server leaves every unaliased expression unnamed) or two
 * columns with one name (a join that projects `id` from both tables). A row keyed by name then loses a value,
 * or carries an empty key no grid column can take. So a column with no name is named `UNNAMED_FIELD`, and a
 * repeat is numbered `name (2)`, `name (3)`, as the Db2, Druid, Trino and search transports already number
 * theirs. A number never produces a name the result itself declares, before or after the repeat, so no column
 * the statement named is shown under another column's value.
 *
 * Read the rows positionally and key them by these names; reading them keyed by the declared names is what
 * loses the value in the first place. Names that differ only in letter case stay apart, as row keys do.
 *
 * Server only, and it names no engine.
 */
export function uniqueFieldNames(declared: readonly string[]): string[] {
  const declaredNames = new Set(declared);
  const given = new Set<string>();
  return declared.map((name) => {
    const base = name === "" ? UNNAMED_FIELD : name;
    // A column keeps its own declared name the first time; any other name must be one nothing declares.
    const free = (candidate: string) => !given.has(candidate) && (candidate === name || !declaredNames.has(candidate));
    let unique = base;
    for (let repeat = 2; !free(unique); repeat += 1) unique = `${base} (${repeat})`;
    given.add(unique);
    return unique;
  });
}
