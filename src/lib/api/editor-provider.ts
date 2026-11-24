import { editorExecutionContext } from "@/lib/api/execution-context";
import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { getOrCreateProvider } from "@/lib/db";
import { findCachedProvider, getOrCreateMetadataProvider } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The provider an editor request runs on: the connection's cached provider, opened under the
 * session's editor posture, and on a server-level connection the session of `catalog` (#1530).
 * Under governance it is the session's own provider: the session's `idpSubject` reaches the
 * execution context as its owner (docs/GOVERNANCE.md#per-user-providers).
 *
 * The one place a route decides this, so no route opens a provider under another posture or skips
 * the catalog check; `metadataProvider` below is the one other provider this file decides, the same way. Routes that act on the whole connection rather than in one database, such as
 * cancel, which finds a statement in whichever session runs it, call `getOrCreateProvider` directly.
 *
 * `wait` is the request's own wait for the open (`openWithinCall` in src/lib/api/editor-query.ts), handed to
 * `getOrCreateProvider` as it is; a catalog session opens after it, on the same connection.
 */
export async function editorProvider(
  session: { role: string; idpSubject?: string },
  connection: DatabaseConnection,
  catalog: string | undefined,
  wait?: OpenWait,
): Promise<DatabaseProvider> {
  const connected = await getOrCreateProvider(connection, {}, editorExecutionContext(session, connection), wait);
  return scopeToCatalog(connected, catalog);
}

/**
 * The connection's metadata session (docs/providers/CONTRACT.md, clause C-66), opened under the session's editor
 * posture as `editorProvider` opens the editor's provider: the same connection, credentials, grant and owner, through
 * the same checks, and in `catalog` through the same `scopeToCatalog`. On a connection that serves one session it is
 * the editor's own provider. The maintenance route runs a kill on it, so the kill never waits for a connection the
 * editor's statements hold.
 */
export async function metadataProvider(
  session: { role: string; idpSubject?: string },
  connection: DatabaseConnection,
  catalog: string | undefined,
): Promise<DatabaseProvider> {
  const connected = await getOrCreateMetadataProvider(connection, {}, editorExecutionContext(session, connection));
  return scopeToCatalog(connected, catalog);
}

/**
 * The provider an earlier editor request ran on, as `editorProvider` handed it out: the one the writable cache still
 * holds under `key`, the key that request resolved (`editorCacheKey` in src/lib/db/factory.ts), in `catalog`; or null
 * when the cache no longer holds one there. It opens no provider. The transaction route rolls back on it a governed
 * transaction whose owner's credential changed since its `begin` (docs/GOVERNANCE.md#per-user-providers).
 */
export async function cachedEditorProvider(key: string, catalog: string | undefined): Promise<DatabaseProvider | null> {
  const cached = findCachedProvider(key);
  return cached === null ? null : scopeToCatalog(cached, catalog);
}
