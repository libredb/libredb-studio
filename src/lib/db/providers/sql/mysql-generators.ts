/**
 * MySQL's identifier quoting, bound by Studio's SQL generator function table (`SQL_GENERATOR_FUNCTIONS` in
 * `src/lib/db/query-generators/index.ts`) at the slot its name gives.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/** MySQL: case-preserving, so only a name with special characters is backtick-quoted. */
export const MYSQL_GENERATOR_QUOTE: SqlEngineGenerators["quote"] = (name, always) =>
  !always && /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
