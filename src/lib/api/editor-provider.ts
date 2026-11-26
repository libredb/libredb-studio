import type { EditorRunTarget } from "@/lib/api/editor-query";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { getOrCreateProvider } from "@/lib/db";
import { findCachedProvider, getOrCreateEditorSession, getOrCreateMetadataProvider } from "@/lib/db/factory";
import type { EngineConnection, EngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseProvider } from "@/lib/db/types";
import { HostDefectError } from "@/lib/provider-host/access";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The provider an editor request runs on: the connection's cached provider, opened under the
 * session's editor posture, and on a server-level connection the session of `catalog` (#1530).
 * Under governance it is the session's own provider: the session's `idpSubject` reaches the
 * execution context as its owner (docs/GOVERNANCE.md#per-user-providers).
 *
 * The one place a route decides this, so no route opens a provider under another posture or skips
 * the catalog check; `editorTarget` below opens the same way for any record the server serves, and is how
 * `POST /api/db/query` opens every engine, and `metadataProvider` is the one other provider this file decides, the
 * same way, for the reads and the kill that must not wait for the editor's statements. Routes that act on the whole
 * connection rather than in one database, such as cancel, which finds a statement in whichever session runs it, call
 * `getOrCreateProvider` directly.
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
 * What one editor statement runs on, for any record the server serves: the editor's session of `engine` for
 * `connection` in the provider factory's editor cache (`getOrCreateEditorSession` in src/lib/db/factory.ts), opened
 * under the session's editor posture as `editorProvider` opens it, with the same owner. A record that offers a legacy
 * provider opens through `getOrCreateProvider`'s body with the same arguments, and its provider is scoped to `catalog`
 * through the same `scopeToCatalog`; a provider package's session is answered with its declared environment, the
 * entry, which counts the run while its call runs, and the connection's own statement timeout. `wait` is the request's
 * own wait for the open (`openWithinBudget` in src/lib/api/editor-query.ts), handed to the factory as it is.
 * `POST /api/db/query` opens every engine through it.
 *
 * @throws {HostDefectError} Studio's own defect, when a provider package's session is handed a catalog: the query route
 *   refuses a catalog for an engine whose record offers none before any open. Its one refusal is the request's
 *   `catalog` field not honoured, a rule whose author is Studio (`isStudioFailure` in src/lib/api/package-errors.ts), so
 *   the route answers it as Studio's own internal error, never as the package's.
 */
export async function editorTarget(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  catalog: string | undefined,
  wait?: OpenWait,
): Promise<EditorRunTarget> {
  const entry = await getOrCreateEditorSession(connection, engine, editorExecutionContext(session, connection), wait);
  const { opened } = entry;
  if (opened.form === "provider") return { form: "provider", provider: await scopeToCatalog(opened.provider, catalog) };
  if (catalog !== undefined) {
    throw new HostDefectError([{ rule: "request-field-not-honoured", pointer: "/catalog", name: "catalog" }]);
  }
  return { form: "session", session: opened.session, env: opened.env, entry, queryTimeout: connection.queryTimeout };
}

/**
 * The connection's metadata session (docs/providers/CONTRACT.md, clause C-66), opened under the session's editor
 * posture as `editorProvider` opens the editor's provider: the same connection, credentials, grant and owner, through
 * the same checks, and in `catalog` through the same `scopeToCatalog`. On a connection that serves one session it is
 * the editor's own provider. The monitoring route reads its panels, the health route its health and the maintenance
 * route runs a kill on it, so none of them waits for a connection the editor's statements hold.
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
