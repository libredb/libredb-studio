import type { ConnectionStringPasteReader } from "@/lib/db/connection-string/types";
import { parseSparkConnectUri } from "@/lib/db/providers/sql/spark/sc-uri";

/** The sc:// address, and the Spark Connect JDBC driver's jdbc:sc:// form, which its reader refuses. */
const claimsSpark = (text: string): boolean => text.startsWith("sc://") || text.startsWith("jdbc:sc://");

/**
 * `spark`'s paste reader, of `sc://` or `jdbc:sc://`.
 *
 * Apache Spark declares no scheme on purpose, though its `sc://` address is pasted and decomposed
 * (`parseSparkConnectUri`): the login signature prints every scheme with the tail `user@db.internal:<port>/app`, and
 * Spark's grammar refuses both a user part and a path, so the hero would show an address the product refuses. Its paste
 * names no type for `detectConnectionStringType`, which has never named Spark.
 */
export const SPARK_PASTE_READER: ConnectionStringPasteReader = Object.freeze({
  claims: claimsSpark,
  names: () => false,
  parse: parseSparkConnectUri,
});
