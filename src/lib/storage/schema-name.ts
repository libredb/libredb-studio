/**
 * PostgreSQL schema names read from the environment.
 *
 * Studio puts a schema name into SQL text, because an identifier cannot be a bind parameter. So the
 * name is accepted only when it is a plain lowercase identifier that PostgreSQL would fold to itself
 * and that fits its 63-byte limit; everything else is refused here, before it can reach a statement.
 * STORAGE_POSTGRES_SCHEMA and GOVERNANCE_POSTGRES_SCHEMA share this one rule.
 */

/** The rule itself, also applied where a governance statement quotes the schema it names. */
export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The schema name in `variable`, or `fallback` when the variable is unset or empty.
 * Throws, naming the variable and the value, when the value is not a plain lowercase identifier.
 */
export function readSchemaName(variable: string, fallback: string): string;
export function readSchemaName(variable: string, fallback?: string): string | undefined;
export function readSchemaName(variable: string, fallback?: string): string | undefined {
  const value = process.env[variable];
  if (value === undefined || value === "") return fallback;
  if (!SCHEMA_NAME.test(value)) {
    throw new Error(
      `${variable} must be a lowercase PostgreSQL schema name matching ${SCHEMA_NAME.source}, got "${value}"`,
    );
  }
  return value;
}
