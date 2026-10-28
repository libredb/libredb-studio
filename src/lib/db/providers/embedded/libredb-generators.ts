/**
 * The LibreDB dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. Browser-safe: it reads only the shared generator pieces.
 */
import { commentName, objectSegment, prefixGroup } from "@/lib/db/query-generators/shared";
import type { DialectGenerators } from "@/lib/db/query-generators/types";
import type { ColumnSchema } from "@/lib/types";

/** A concrete example JSON scalar for a catalog column type (LibreDB column
 * types are `string` | `number` | `boolean` | `object`; unknowns read as text). */
function libredbExampleForType(type: string): unknown {
  switch (type.toLowerCase()) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "object":
      return {};
    default:
      return "example";
  }
}

/**
 * A concrete, runnable example VALUE for a `put` against a group, shaped by the
 * group's columns so the generated command works as-is when selected and run:
 *  - raw kv (`key`/`value` columns) → a plain string value
 *  - document collection (`id`/`document`) → a small JSON object
 *  - relational table → a JSON object built from the declared columns
 */
function libredbExampleValue(columns: readonly ColumnSchema[]): string {
  if (columns.length === 2 && columns[0]?.name === "key" && columns[1]?.name === "value") {
    return "example";
  }
  if (columns.length === 2 && columns[1]?.name === "document") {
    return `'{"name":"example"}'`;
  }
  const obj: Record<string, unknown> = {};
  for (const c of columns) obj[c.name] = libredbExampleForType(c.type);
  return `'${JSON.stringify(obj)}'`;
}

/**
 * The one refusal both LibreDB generators give for a name they cannot address:
 * a `#` note and no command line. A schema-tree node name is a real key name,
 * LibreDB keys are arbitrary byte strings, and every LibreDB command is
 * line-oriented — `get`/`put`/`delete`/`prefix` interpolate the name raw, so a
 * key named `x\ndelete billing:2024` renders its own second half as a runnable
 * `delete billing:2024` line. LibreDB has no lossless JSON command form to fall
 * back to the way Redis does, so emit no command line at all and say why. Both
 * callers go through here so the two branches cannot drift (#427, U11).
 */
function libredbNewlineNote(base: string): string | null {
  if (!/[\r\n]/.test(base)) return null;
  // No "write it by hand" advice: `firstCommandLine` splits the buffer on LF before tokenizing
  // (providers/embedded/libredb.ts), so a key whose name contains a LINE FEED cannot be reached
  // from this editor at all, quoted or not. A carriage return survives inside quotes and could be
  // typed by hand - but one note covers both characters, and promising an action that fails for
  // half of them is worse than promising none.
  return "# This key's name contains a line break. LibreDB commands are line-oriented, so no generated line can address it.";
}

/**
 * The LibreDB cheatsheet: a use-case comment over each command, where every
 * command line is a concrete, directly-runnable example (so "Run Selected" on
 * any line works as-is). The provider skips `#` comment and blank lines, so
 * running the whole buffer runs its first real command.
 */
function libredbCheatsheet(tableName: string, columns: readonly ColumnSchema[]): string {
  const { isPrefixGroup, base } = prefixGroup(tableName);
  const value = libredbExampleValue(columns);
  const header = `# LibreDB commands for ${commentName(tableName)} — select a line and Run Selected.`;
  // The header is JSON-quoted so a newline in a name cannot end it; the command
  // lines have no such protection, so a name carrying one gets the shared refusal.
  const note = libredbNewlineNote(base);
  if (note !== null) {
    return [header, "", note].join("\n");
  }
  if (isPrefixGroup) {
    const key = `${base}1`; // a concrete example key (e.g. users:1)
    return [
      header,
      "",
      "# List every key under this prefix",
      `prefix ${base}`,
      "",
      "# Read one entry by key",
      `get ${key}`,
      "",
      "# Create or update an entry",
      `put ${key} ${value}`,
      "",
      "# Delete an entry",
      `delete ${key}`,
    ].join("\n");
  }
  return [
    header,
    "",
    "# Read the value",
    `get ${base}`,
    "",
    "# Create or update it",
    `put ${base} ${value}`,
    "",
    "# Delete it",
    `delete ${base}`,
  ].join("\n");
}

/**
 * LibreDB speaks its own command grammar (get/put/delete/prefix/range), not SQL and not MongoDB JSON. "Scan" lists
 * everything under the group's prefix, and "Scan Keys" AUTO-EXECUTES, so a newline in the name, which used to leave a
 * second, plausible command one "Run Selected" away, gets the shared refusal (U11). "Generate Command" writes an
 * explanatory cheatsheet, a use-case comment above each command and every command line a concrete, directly runnable
 * example; the provider skips `#` comment and blank lines, so running the whole buffer runs its first real command.
 */
export const LIBREDB_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path) => {
    const { isPrefixGroup, base } = prefixGroup(objectSegment(path));
    const note = libredbNewlineNote(base);
    if (note !== null) return note;
    return isPrefixGroup ? `prefix ${base}` : `get ${base}`;
  },
  select: (path, columns) => libredbCheatsheet(objectSegment(path), columns),
});
