import type { ConnectionStringPasteReader } from "@/lib/db/connection-string/types";
import { claimsDatabendPaste, namesDatabendPaste, parseDatabendPaste } from "@/lib/db/providers/sql/databend/paste";

/**
 * `databend`'s paste reader, of a BendSQL DSN: it reads a DSN's `sslmode` itself, by BendSQL's own rules, so its
 * declaration names no URL TLS reader.
 */
export const DATABEND_PASTE_READER: ConnectionStringPasteReader = Object.freeze({
  claims: claimsDatabendPaste,
  names: namesDatabendPaste,
  parse: parseDatabendPaste,
});
