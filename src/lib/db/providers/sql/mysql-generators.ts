/**
 * MySQL's identifier quoting, collected as its row of `SQL_ENGINE_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`, read under its type id.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/** MySQL: case-preserving, so only a name with special characters is backtick-quoted. */
export const MYSQL_SQL_GENERATORS = Object.freeze({
  quote: (name, always) => (!always && /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``),
} satisfies SqlEngineGenerators);
