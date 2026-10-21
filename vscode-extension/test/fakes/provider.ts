/**
 * A recording fake `DatabaseProvider` for the backend's unit tests: the root's `tests/helpers/mock-provider.ts` is
 * Bun-only, and the extension's unit leg runs under Mocha on Node.
 * It implements only the surface the handlers call, and records every call as `[method, ...args]`.
 */
import type {
  DatabaseProvider,
  PreparedQuery,
  ProviderCapabilities,
  ProviderLabels,
  QueryPrepareOptions,
} from "@/lib/db/types";
import type { QueryCancelProvider } from "@/lib/db/query-cancel";
import type { QueryResult } from "@/lib/types";

/** Copied into a description and read field by field by no handler, so a small literal stands for the whole. */
export const CAPS = { defaultPort: 5432, supportsCreateDatabase: true } as unknown as ProviderCapabilities;
/**
 * PostgreSQL-shaped for the generator and the run target: its port picks the double-quote rule, no statementTerminator
 * declaration means ";", and one table kind with columns. No previewProjection, so Select Rows describes nothing.
 */
export const SQL_CAPS = {
  defaultPort: 5432,
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true }],
} as unknown as ProviderCapabilities;
export const LABELS = { entityName: "Table", entityNamePlural: "Tables" } as unknown as ProviderLabels;

/** The limiter's rule as a SQL provider applies it: a bound of ours, unless the text carries its own LIMIT. */
function limiter(sql: string, options: QueryPrepareOptions = {}): PreparedQuery {
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;
  if (options.unlimited === true || /\blimit\b/i.test(sql)) return { query: sql, wasLimited: false, limit, offset };
  return { query: `${sql} LIMIT ${limit} OFFSET ${offset}`, wasLimited: true, limit, offset };
}

export const rowsOf = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, n) => ({ n: n + 1 }));

export const resultOf = (rows: Record<string, unknown>[], more: Partial<QueryResult> = {}): QueryResult => ({
  rows,
  fields: ["n"],
  rowCount: rows.length,
  executionTime: 3,
  ...more,
});

/** The provider surface a test may replace, cancellation included, which `DatabaseProvider` leaves optional. */
export type ProviderSurface = Partial<DatabaseProvider & QueryCancelProvider>;

export interface FakeProvider extends DatabaseProvider {
  /** Every call the handlers made, as `[method, ...args]`, in order. */
  readonly calls: unknown[][];
}

/** A postgres-typed fake answering three rows to any query, with no cancelQuery, endOpenQueryTransaction or forCatalog. */
export function fakeProvider(over: ProviderSurface = {}): FakeProvider {
  const calls: unknown[][] = [];
  const surface: Record<string, unknown> = {
    type: "postgres",
    getCapabilities: () => CAPS,
    getLabels: () => LABELS,
    prepareQuery: limiter,
    query: async () => resultOf(rowsOf(3)),
    ...over,
  };
  const provider: Record<string, unknown> = { calls };
  for (const [name, value] of Object.entries(surface)) {
    provider[name] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            calls.push([name, ...args]);
            return value(...args);
          }
        : value;
  }
  return provider as unknown as FakeProvider;
}
