/**
 * SQL Server's generator forms, collected as its row of `SQL_ENGINE_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`, read under its type id.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/**
 * SQL Server: case-insensitive, so only a name with special characters is bracket-quoted. Generate Query spells its
 * row bound `SELECT TOP 100` and keeps a literal `;`, which it accepts. Generate Count Query counts with `COUNT_BIG`:
 * `COUNT` returns an int, and `COUNT_BIG` preserves billion-row counts.
 */
export const MSSQL_SQL_GENERATORS = Object.freeze({
  quote: (name, always) => (!always && /^[A-Za-z_]\w*$/.test(name) ? name : `[${name.replaceAll("]", "]]")}]`),
  selectList: (table, cols) => `SELECT TOP 100\n${cols}\nFROM ${table}\nWHERE 1=1;`,
  countExpression: "COUNT_BIG(*)",
} satisfies SqlEngineGenerators);
