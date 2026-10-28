/**
 * SQL Server's generator forms, collected as its row by `SQL_PORT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`, keyed by the port its declaration names.
 */
import type { SqlPortGenerators } from "@/lib/db/query-generators/types";

/** The SQL Server port, the capability signal for its forms. */
const MSSQL_PORT = 1433;

/**
 * SQL Server: case-insensitive, so only a name with special characters is bracket-quoted. Generate Query spells its
 * row bound `SELECT TOP 100` and keeps a literal `;`, which it accepts. Generate Count Query counts with `COUNT_BIG`:
 * `COUNT` returns an int, and `COUNT_BIG` preserves billion-row counts.
 */
export const MSSQL_SQL_GENERATORS = Object.freeze({
  port: MSSQL_PORT,
  quote: (name, always) => (!always && /^[A-Za-z_]\w*$/.test(name) ? name : `[${name.replaceAll("]", "]]")}]`),
  selectList: (table, cols) => `SELECT TOP 100\n${cols}\nFROM ${table}\nWHERE 1=1;`,
  countExpression: "COUNT_BIG(*)",
} satisfies SqlPortGenerators);
