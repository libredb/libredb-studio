import { parseGenericURL } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

const claimsOracle = (text: string): boolean => text.startsWith("oracle://");

/** `oracle`: the `oracle://` scheme, no TLS read from the URL query, a paste of `oracle://`, no seed load check. */
export const ORACLE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: "oracle",
  readTls: null,
  paste: {
    catchAll: false,
    claims: claimsOracle,
    names: claimsOracle,
    parse: (text) => parseGenericURL(text, "oracle", "1521", null),
    formats: ["oracle://"],
  },
  validateSeed: null,
};
