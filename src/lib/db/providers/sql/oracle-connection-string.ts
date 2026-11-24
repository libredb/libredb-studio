import { parseGenericURL } from "@/lib/db/connection-string/shared";
import type { ConnectionStringPasteReader } from "@/lib/db/connection-string/types";

const claimsOracle = (text: string): boolean => text.startsWith("oracle://");

/** `oracle`'s paste reader, of `oracle://`, which reads no TLS from the URL query. */
export const ORACLE_PASTE_READER: ConnectionStringPasteReader = Object.freeze({
  claims: claimsOracle,
  names: claimsOracle,
  parse: (text: string) => parseGenericURL(text, "oracle", "1521", null),
});
