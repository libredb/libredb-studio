/**
 * Oracle's generator forms, each bound by Studio's SQL generator function table (`SQL_GENERATOR_FUNCTIONS` in
 * `src/lib/db/query-generators/index.ts`) at the slot its name gives.
 *
 * Oracle: an unquoted name folds to UPPERCASE, so a name is quoted unless it is plain upper case. Generate Query
 * spells its row bound `FETCH FIRST 100 ROWS ONLY`, ending in the declared terminator.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

export const ORACLE_GENERATOR_QUOTE: SqlEngineGenerators["quote"] = (name, always) =>
  !always && /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;

export const ORACLE_GENERATOR_SELECT_LIST: NonNullable<SqlEngineGenerators["selectList"]> = (
  table,
  cols,
  { terminator },
) => `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY${terminator}`;
