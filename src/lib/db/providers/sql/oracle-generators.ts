/**
 * Oracle's generator forms, collected as its row of `SQL_ENGINE_GENERATORS` in `src/lib/db/query-generators/index.ts`,
 * read under its type id.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/**
 * Oracle: an unquoted name folds to UPPERCASE, so a name is quoted unless it is plain upper case. Generate Query
 * spells its row bound `FETCH FIRST 100 ROWS ONLY`, ending in the declared terminator.
 */
export const ORACLE_SQL_GENERATORS = Object.freeze({
  quote: (name, always) => (!always && /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`),
  selectList: (table, cols, { terminator }) =>
    `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY${terminator}`,
} satisfies SqlEngineGenerators);
