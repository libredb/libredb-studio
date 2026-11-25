/**
 * SQL Server's generator forms, each bound by Studio's SQL generator function table (`SQL_GENERATOR_FUNCTIONS` in
 * `src/lib/db/query-generators/index.ts`) at the slot its name gives.
 *
 * SQL Server: case-insensitive, so only a name with special characters is bracket-quoted. Generate Query spells its
 * row bound `SELECT TOP 100` and keeps a literal `;`, which it accepts.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

export const MSSQL_GENERATOR_QUOTE: SqlEngineGenerators["quote"] = (name, always) =>
  !always && /^[A-Za-z_]\w*$/.test(name) ? name : `[${name.replaceAll("]", "]]")}]`;

export const MSSQL_GENERATOR_SELECT_LIST: NonNullable<SqlEngineGenerators["selectList"]> = (table, cols) =>
  `SELECT TOP 100\n${cols}\nFROM ${table}\nWHERE 1=1;`;
