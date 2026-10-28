import { CONNECTION_STRING_PASTES } from "@/lib/db/connection-string";
import type { ParsedConnection } from "@/lib/db/connection-string/types";
import type { DatabaseType } from "@/lib/types";

/**
 * What a pasted connection string parses to. Declared in the connection string registry's types, beside the rows that
 * produce it, and re-exported here so the form, the extension and the tests keep one import.
 */
export type { ParsedConnection } from "@/lib/db/connection-string/types";

/**
 * The canonical URI scheme each engine is reachable by, for the engines that HAVE one. Derived inside the connection
 * string registry (src/lib/db/connection-string), where the reasons each gap is deliberate live, and re-exported here
 * so the login signature and the parser tests keep one import.
 */
export { ENGINE_URI_SCHEMES } from "@/lib/db/connection-string";

/**
 * The sentences and notices of a Databend and a Snowflake paste, declared beside their providers and re-exported here
 * for the form that shows them.
 */
export {
  DATABEND_DSN_CAUTIONS,
  DATABEND_DSN_REFUSALS,
  DATABEND_SSLMODE_NOTICES,
  databendNotAppliedNotice,
} from "@/lib/db/providers/sql/databend/paste";
export { SNOWFLAKE_PASTE_SENTENCES } from "@/lib/db/providers/sql/snowflake/paste";

/**
 * The text every row's `claims` and `parse` read: the paste trimmed, with its scheme lower-cased.
 *
 * URI schemes ignore case (RFC 3986 6.2.2.1; #1916); every character after `://` keeps its case.
 * The JDBC wrapper is read with its inner scheme too, while text that is not a URI - a shell
 * export, an ADO.NET password with `://` inside - is returned exactly as typed.
 */
export function pasteText(input: string): string {
  const trimmed = input.trim();
  const schemeEnd = trimmed.indexOf("://");
  if (schemeEnd === -1) return trimmed;
  const prefix = trimmed.slice(0, schemeEnd);
  if (!/^(?:jdbc:)?[a-z][a-z0-9+.-]*$/i.test(prefix)) return trimmed;
  return prefix.toLowerCase() + trimmed.slice(schemeEnd);
}

/**
 * Parse a database connection string into its components, or null when no row reads it.
 *
 * Each engine that reads a paste declares, beside its provider, the texts it claims and how it parses them (the
 * `paste` of its row in `CONNECTION_STRING`); this function names no engine. It offers the text to the rows in the one
 * order the registry declares, `CONNECTION_STRING_PASTE_ORDER`, and the first row that claims it parses it, which may
 * be a refusal naming what to paste instead.
 */
export function parseConnectionString(input: string): ParsedConnection | null {
  const text = pasteText(input);
  if (!text) return null;
  const row = CONNECTION_STRING_PASTES.find(({ paste }) => paste.claims(text));
  return row === undefined ? null : row.paste.parse(text);
}

/**
 * Detect the database type from a connection string: the first row, in the same order, that names the text lower-cased
 * whole. A row names only the spellings it connects with, so a text it refuses by name is detected as no type.
 */
export function detectConnectionStringType(input: string): DatabaseType | null {
  const text = input.trim().toLowerCase();
  return CONNECTION_STRING_PASTES.find(({ paste }) => paste.names(text))?.type ?? null;
}
