import type { ConnectionImportDeclaration } from "@/lib/connection-import";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * Declares `connectionImport` on one real `DB_UI_CONFIG` entry for one test and returns the undo, which the test runs
 * in `afterEach`, as `declareHostUri` does for `hostAcceptsUri`, so the dialog's import is proven with a stub parser
 * on an entry that declares none.
 */
export function declareConnectionImport(type: DatabaseType, declaration: ConnectionImportDeclaration): () => void {
  const entry = DB_UI_CONFIG[type];
  const before = entry.connectionImport;
  entry.connectionImport = declaration;
  return () => {
    if (before === undefined) delete entry.connectionImport;
    else entry.connectionImport = before;
  };
}
