import type { ProviderCapabilities } from '@/lib/db/types';
import type { ColumnSchema } from '@/lib/types';

export function generateTableQuery(tableName: string, capabilities: ProviderCapabilities): string {
  if (capabilities.queryLanguage === 'json') {
    return JSON.stringify(
      { collection: tableName, operation: 'find', filter: {}, options: { limit: 50 } },
      null,
      2
    );
  }
  return `SELECT * FROM ${tableName} LIMIT 50;`;
}

export function generateSelectQuery(
  tableName: string,
  columns: ColumnSchema[],
  capabilities: ProviderCapabilities
): string {
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
  const cols = columns.map((c) => `  ${c.name}`).join(',\n') || '  *';
  return `SELECT\n${cols}\nFROM ${tableName}\nWHERE 1=1\nLIMIT 100;`;
}

export function shouldRefreshSchema(query: string, schemaRefreshPattern: string): boolean {
  return new RegExp(schemaRefreshPattern, 'i').test(query);
}
