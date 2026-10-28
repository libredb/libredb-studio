/**
 * MySQL's identifier quoting, collected as its row by `SQL_PORT_GENERATORS` in `src/lib/db/query-generators/index.ts`,
 * keyed by the port its declaration names.
 */
import type { SqlPortGenerators } from "@/lib/db/query-generators/types";

/** The MySQL port, the capability signal for its quoting. */
const MYSQL_PORT = 3306;

/** MySQL: case-preserving, so only a name with special characters is backtick-quoted. */
export const MYSQL_SQL_GENERATORS = Object.freeze({
  port: MYSQL_PORT,
  quote: (name, always) => (!always && /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``),
} satisfies SqlPortGenerators);
