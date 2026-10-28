/**
 * Oracle's generator forms, collected as its row by `SQL_PORT_GENERATORS` in `src/lib/db/query-generators/index.ts`,
 * keyed by the listener port its declaration names.
 */
import type { SqlPortGenerators } from "@/lib/db/query-generators/types";

/** The Oracle listener port, the capability signal for its forms. */
const ORACLE_PORT = 1521;

/**
 * Oracle: an unquoted name folds to UPPERCASE, so a name is quoted unless it is plain upper case. Generate Query
 * spells its row bound `FETCH FIRST 100 ROWS ONLY`, ending in the declared terminator.
 */
export const ORACLE_SQL_GENERATORS = Object.freeze({
  port: ORACLE_PORT,
  quote: (name, always) => (!always && /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`),
  selectList: (table, cols, { terminator }) =>
    `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY${terminator}`,
} satisfies SqlPortGenerators);
