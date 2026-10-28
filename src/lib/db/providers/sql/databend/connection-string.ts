import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";
import { claimsDatabendPaste, namesDatabendPaste, parseDatabendPaste } from "@/lib/db/providers/sql/databend/paste";

/**
 * `databend`: the `databend://` scheme, no TLS read from the URL query (its paste reads a DSN's `sslmode` itself, by
 * BendSQL's own rules), a paste of a BendSQL DSN, no seed load check.
 */
export const DATABEND_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "databend",
  readTls: null,
  paste: {
    catchAll: false,
    claims: claimsDatabendPaste,
    names: namesDatabendPaste,
    parse: parseDatabendPaste,
    formats: ["databend://"],
  },
  validateSeed: null,
};
