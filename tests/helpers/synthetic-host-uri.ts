import type { HostUriScheme } from "@/lib/connection-host-uri";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * Declares `hostAcceptsUri` on one real `DB_UI_CONFIG` entry for one test and returns the undo, which the test
 * runs in `afterEach`. Qdrant is the one shipped entry that declares it, so the mechanism is proven on another entry this way.
 */
export function declareHostUri(type: DatabaseType, schemes: readonly HostUriScheme[]): () => void {
  const entry = DB_UI_CONFIG[type];
  const before = entry.hostAcceptsUri;
  entry.hostAcceptsUri = schemes;
  return () => {
    if (before === undefined) delete entry.hostAcceptsUri;
    else entry.hostAcceptsUri = before;
  };
}
