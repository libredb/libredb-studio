import type { ProviderCapabilities } from '@/lib/db/types';
import type { ColumnSchema } from '@/lib/types';

/**
 * Quote a SQL identifier (table/column) for the target dialect, but ONLY when
 * needed. Plain identifiers that round-trip unquoted are left as-is so generated
 * SQL stays readable and existing behavior is preserved; mixed-case / special /
 * fold-sensitive names get the dialect's quoting.
 *
 * Dialect is derived from the provider capabilities (same signals the generators
 * already branch on), so no provider code needs to change:
 *  - Oracle (1521): unquoted folds to UPPERCASE  → quote unless plain UPPER
 *  - SQL Server (1433): case-insensitive          → bracket-quote only specials
 *  - MySQL (3306): case-preserving                → backtick-quote only specials
 *  - PostgreSQL (5432) / SQLite / default: unquoted folds to lowercase (pg)
 *                                                  → quote unless plain lower
 */
export function quoteIdentifier(name: string, capabilities: ProviderCapabilities): string {
  // Document stores (MongoDB) don't use SQL identifier quoting.
  if (capabilities.queryLanguage === 'json') return name;

  if (capabilities.defaultPort === 1521) {
    // Oracle
    return /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
  }
  if (capabilities.defaultPort === 1433) {
    // SQL Server
    return /^[A-Za-z_]\w*$/.test(name) ? name : `[${name.replaceAll(']', ']]')}]`;
  }
  if (capabilities.defaultPort === 3306) {
    // MySQL
    return /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replaceAll('`', '``')}\``;
  }
  // PostgreSQL / SQLite / default
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quote a possibly schema-qualified name (e.g. `employees.department`) by quoting
 * each dotted segment independently. Quoting the whole string as one identifier
 * (`"employees.department"`) would make the database look for a single relation
 * literally named with a dot, which fails. Each segment is still quoted only when
 * needed, so `employees.department` stays unquoted and `public.Order` becomes
 * `public."Order"`.
 */
export function quoteQualifiedName(name: string, capabilities: ProviderCapabilities): string {
  if (capabilities.queryLanguage === 'json') return name;
  return name
    .split('.')
    .map((part) => quoteIdentifier(part, capabilities))
    .join('.');
}

/**
 * Resolve a LibreDB schema-tree node name to its command shape. A node is either
 * a `:`-prefix group (e.g. `users:*`, whose rows live under the `users:` prefix)
 * or a bare single key with no colon. The `*` is stripped so the base is the
 * literal prefix used in commands (`users:*` -> `users:`).
 */
function libredbGroup(name: string): { isPrefixGroup: boolean; base: string } {
  if (name.endsWith(':*')) return { isPrefixGroup: true, base: name.slice(0, -1) };
  return { isPrefixGroup: false, base: name };
}

export function generateTableQuery(tableName: string, capabilities: ProviderCapabilities): string {
  // LibreDB speaks its own command grammar (get/put/delete/prefix/range), not SQL
  // and not MongoDB JSON. "Scan" lists everything under the group's prefix.
  if (capabilities.queryDialect === 'libredb') {
    const { isPrefixGroup, base } = libredbGroup(tableName);
    return isPrefixGroup ? `prefix ${base}` : `get ${base}`;
  }
  if (capabilities.queryLanguage === 'json') {
    return JSON.stringify(
      { collection: tableName, operation: 'find', filter: {}, options: { limit: 50 } },
      null,
      2
    );
  }
  const table = quoteQualifiedName(tableName, capabilities);
  // Oracle
  if (capabilities.defaultPort === 1521) {
    return `SELECT * FROM ${table} FETCH FIRST 50 ROWS ONLY;`;
  }
  // MSSQL
  if (capabilities.defaultPort === 1433) {
    return `SELECT TOP 50 * FROM ${table};`;
  }
  return `SELECT * FROM ${table} LIMIT 50;`;
}

export function generateSelectQuery(
  tableName: string,
  columns: ColumnSchema[],
  capabilities: ProviderCapabilities
): string {
  // LibreDB: emit a runnable, comment-free cheatsheet — one valid command per
  // line — covering list/get/create-update/delete for this group, so the user
  // can run a line (or edit it) instead of memorizing the grammar.
  if (capabilities.queryDialect === 'libredb') {
    const { isPrefixGroup, base } = libredbGroup(tableName);
    if (isPrefixGroup) {
      const key = `${base}<key>`;
      return [`prefix ${base}`, `get ${key}`, `put ${key} <value>`, `delete ${key}`].join('\n');
    }
    return [`get ${base}`, `put ${base} <value>`, `delete ${base}`].join('\n');
  }
  if (capabilities.queryLanguage === 'json') {
    const projection: Record<string, number> = {};
    columns.forEach((c) => {
      projection[c.name] = 1;
    });
    return JSON.stringify(
      {
        collection: tableName,
        operation: 'find',
        filter: {},
        options: {
          projection: Object.keys(projection).length > 0 ? projection : undefined,
          limit: 100,
        },
      },
      null,
      2
    );
  }
  const table = quoteQualifiedName(tableName, capabilities);
  const cols = columns.map((c) => `  ${quoteIdentifier(c.name, capabilities)}`).join(',\n') || '  *';
  // Oracle
  if (capabilities.defaultPort === 1521) {
    return `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY;`;
  }
  // MSSQL
  if (capabilities.defaultPort === 1433) {
    return `SELECT TOP 100\n${cols}\nFROM ${table}\nWHERE 1=1;`;
  }
  return `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nLIMIT 100;`;
}

export function shouldRefreshSchema(query: string, schemaRefreshPattern: string): boolean {
  return new RegExp(schemaRefreshPattern, 'i').test(query);
}
