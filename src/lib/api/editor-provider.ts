import type { EditorRunTarget } from "@/lib/api/editor-query";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { getOrCreateProvider, readProviderDeclarations } from "@/lib/db";
import {
  type CachedSession,
  findCachedProvider,
  getOrCreateEditorSession,
  getOrCreateMetadataProvider,
  getOrCreateMetadataSession,
} from "@/lib/db/factory";
import { type DeclaredFacet, FacetNotOfferedError, markNotSent } from "@/lib/db/errors";
import {
  type EngineConnection,
  type EngineRecord,
  legacyConnection,
  legacyProviderType,
} from "@/lib/db/server-catalog";
import type { DatabaseProvider } from "@/lib/db/types";
import {
  type ConsoleTarget,
  entryConsoleTarget,
  entryMonitoringTarget,
  entryTreeTarget,
  type MaintenanceOpening,
  type MonitoringTarget,
  packageMaintenanceOpening,
  providerMaintenanceTarget,
  providerMonitoringTarget,
  type TreeTarget,
} from "@/lib/api/session-target";
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
 * same way, for the maintenance kill that must not wait for the editor's statements, as `metadataTreeTarget` decides
 * the object tree's session of any record and `metadataMonitoringTarget` and `editorMonitoringTarget` the monitoring
 * reads' sessions of any record. The cancel, which acts on the whole connection rather than in one database and finds
 * a statement in whichever session runs it, opens through `editorConsoleTarget` below, with no catalog.
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
  assertNoSessionCatalog(catalog);
  return { form: "session", session: opened.session, env: opened.env, entry, queryTimeout: connection.queryTimeout };
}

/**
 * Refuses `catalog` handed with a provider package's session, which serves no catalog session, as Studio's own defect:
 * every caller refuses a catalog for an engine whose record offers none before any open (`assertCatalogOffered`, or the
 * query route's own check), so a catalog reaches a package's session only through a record that offers one, which no
 * package's record does. Its one refusal is the request's `catalog` field not honoured, a rule whose author is Studio
 * (`isStudioFailure` in src/lib/api/package-errors.ts), so a route answers it as Studio's own internal error, never as
 * the package's, and never ignores the catalog.
 *
 * @throws {HostDefectError} When `catalog` is named.
 */
function assertNoSessionCatalog(catalog: string | undefined): void {
  if (catalog !== undefined) {
    throw new HostDefectError([{ rule: "request-field-not-honoured", pointer: "/catalog", name: "catalog" }]);
  }
}

/**
 * The console target of `connection`'s editor session of `engine`, for any record the server serves: the entry
 * `getOrCreateEditorSession` answers (src/lib/db/factory.ts), opened under the session's editor posture as
 * `editorProvider` opens the editor's provider, with the same owner, and with no catalog, since a cancel acts on the
 * whole connection, read by its form (`entryConsoleTarget` in ./session-target): a legacy provider's bridged session,
 * or a provider package's session with its declared environment and each call counted on the entry. `wait` is the
 * request's own wait for the open (`openWithinBudget` in src/lib/api/editor-query.ts), handed to the factory as it is.
 * `POST /api/db/cancel` opens through it, so a cancel finds the run on the editor's session the run's own request
 * opened; where none is cached it opens one, which finds no run.
 */
export async function editorConsoleTarget(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  wait?: OpenWait,
): Promise<ConsoleTarget> {
  const entry = await getOrCreateEditorSession(connection, engine, editorExecutionContext(session, connection), wait);
  return entryConsoleTarget(entry, connection);
}

/**
 * The connection's metadata session (docs/providers/CONTRACT.md, clause C-66), opened under the session's editor
 * posture as `editorProvider` opens the editor's provider: the same connection, credentials, grant and owner, through
 * the same checks, and in `catalog` through the same `scopeToCatalog`. On a connection that serves one session it is
 * the editor's own provider. The maintenance route runs a kill on it, so a kill never waits for a connection the
 * editor's statements hold; the monitoring and health routes read any record's metadata session through
 * `metadataMonitoringTarget`.
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
 * The tree target of `connection`'s metadata session of `engine`, for any record the server serves
 * (docs/providers/CONTRACT.md, clause C-66): the entry `getOrCreateMetadataSession` answers (src/lib/db/factory.ts), opened under the
 * session's editor posture as `editorProvider` opens the editor's provider, with the same owner, read by its form
 * (`entryTreeTarget` in ./session-target): a legacy provider's bridged session, or a provider package's session with
 * its declared environment, the connection's own statement timeout and each read counted on the entry. The six tree
 * routes read the object tree on it (`handleObjectRequest` in ./object-route), so a tree read never waits for the
 * editor's statements, except on a connection that serves one session, and MCP's `inspect_schema` reads a provider
 * package's engine on it (`metadataTarget` in src/lib/mcp/context.ts). `wait` is an MCP call's own wait for the open,
 * handed to the factory as it is; the routes hand none.
 */
export async function metadataTreeTarget(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  wait?: OpenWait,
): Promise<TreeTarget> {
  const entry = await getOrCreateMetadataSession(connection, engine, editorExecutionContext(session, connection), wait);
  return entryTreeTarget(entry, connection);
}

/**
 * Refuses `catalog` for `engine` when its record offers no catalog session, before any open: `FacetNotOfferedError` of
 * `facet`, the route's, naming the catalog, outcome not-sent. A record that offers catalog sessions, every legacy
 * record's, has its provider scoped to the catalog after the open (`scopeToCatalog`), which refuses a connection whose
 * provider declares none.
 *
 * @throws {FacetNotOfferedError} Not-sent, when a catalog is named and the record offers no catalog session.
 */
function assertCatalogOffered(engine: EngineRecord, catalog: string | undefined, facet: DeclaredFacet): void {
  if (catalog === undefined || engine.offers.catalog) return;
  const error = new FacetNotOfferedError(
    "This connection's engine offers no catalog session in this LibreDB Studio, so Studio opened nothing.",
    legacyProviderType(engine),
    facet,
    "catalog",
  );
  markNotSent(error);
  throw error;
}

/**
 * The monitoring target of `connection`'s metadata session of `engine`, for any record the server serves
 * (docs/providers/CONTRACT.md, clause C-66): the entry `getOrCreateMetadataSession` answers (src/lib/db/factory.ts),
 * opened under the session's editor posture as `editorProvider` opens the editor's provider, with the same owner, read
 * by its form (`entryMonitoringTarget` in ./session-target): a legacy provider scoped to `catalog` through
 * `scopeToCatalog`, or a provider package's session with its declared environment, the connection's own statement
 * timeout and each read counted on the entry. The monitoring and health routes read on it, so neither waits for the
 * editor's statements, except on a connection that serves one session. A catalog the record does not offer is refused
 * before any open (`assertCatalogOffered`), and a catalog handed with a package's session after it, as Studio's own
 * defect (`assertNoSessionCatalog`).
 */
export async function metadataMonitoringTarget(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  catalog: string | undefined,
): Promise<MonitoringTarget> {
  assertCatalogOffered(engine, catalog, "monitoring");
  const entry = await getOrCreateMetadataSession(connection, engine, editorExecutionContext(session, connection));
  const { opened } = entry;
  if (opened.form === "provider") return providerMonitoringTarget(await scopeToCatalog(opened.provider, catalog));
  assertNoSessionCatalog(catalog);
  return entryMonitoringTarget(entry, connection);
}

/**
 * The monitoring target of `connection`'s editor session of `engine`, for any record the server serves: the entry
 * `getOrCreateEditorSession` answers with no wait of the request's own, opened and read by its form as
 * `metadataMonitoringTarget` reads the metadata session's. The pool statistics route reads on it, since the pool it
 * reports is the editor's. A catalog the record does not offer is refused before any open (`assertCatalogOffered`), and
 * a catalog handed with a package's session after it, as Studio's own defect (`assertNoSessionCatalog`).
 */
export async function editorMonitoringTarget(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  catalog: string | undefined,
): Promise<MonitoringTarget> {
  assertCatalogOffered(engine, catalog, "monitoring");
  const entry = await getOrCreateEditorSession(connection, engine, editorExecutionContext(session, connection));
  const { opened } = entry;
  if (opened.form === "provider") return providerMonitoringTarget(await scopeToCatalog(opened.provider, catalog));
  assertNoSessionCatalog(catalog);
  return entryMonitoringTarget(entry, connection);
}

/**
 * The maintenance opening of `entry`, the editor's or the metadata session of `engine` for `connection`, by its form:
 * a legacy provider scoped to `catalog` through `scopeToCatalog`, whose accepted maintenance is its capabilities, read
 * when asked, and whose target reads its declarations when asked (`readProviderDeclarations`, under the editor posture
 * the session opened under), so a request the route's checks refuse reads none, then builds its maintenance target
 * (`providerMaintenanceTarget` in ./session-target); or a provider package's session, refused a catalog by name
 * (`assertNoSessionCatalog`), whose opening is its entry's (`packageMaintenanceOpening`).
 */
async function maintenanceOpening(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  catalog: string | undefined,
  entry: CachedSession,
): Promise<MaintenanceOpening> {
  const { opened } = entry;
  if (opened.form === "provider") {
    const provider = await scopeToCatalog(opened.provider, catalog);
    return {
      accepted: () => provider.getCapabilities(),
      target: async () => {
        const { capabilities } = await readProviderDeclarations(
          legacyConnection(engine, connection),
          editorExecutionContext(session, connection),
        );
        return providerMaintenanceTarget(provider, capabilities);
      },
    };
  }
  assertNoSessionCatalog(catalog);
  return packageMaintenanceOpening(entry, opened, connection);
}

/**
 * The maintenance opening of `connection`'s editor session of `engine`, for any record the server serves: the entry
 * `getOrCreateEditorSession` answers with no wait of the request's own, opened under the session's editor posture as
 * `editorProvider` opens the editor's provider, read by its form (`maintenanceOpening`). Every maintenance operation but
 * a kill runs on it, and a preview is read on it. A catalog the record does not offer is refused before any open
 * (`assertCatalogOffered`).
 */
export async function editorMaintenanceOpening(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  catalog: string | undefined,
): Promise<MaintenanceOpening> {
  assertCatalogOffered(engine, catalog, "maintenance");
  const entry = await getOrCreateEditorSession(connection, engine, editorExecutionContext(session, connection));
  return maintenanceOpening(session, connection, engine, catalog, entry);
}

/**
 * The maintenance opening of `connection`'s metadata session of `engine` (docs/providers/CONTRACT.md, clause C-66), for
 * any record the server serves: the entry `getOrCreateMetadataSession` answers, opened under the session's editor
 * posture as `editorProvider` opens the editor's provider, read by its form (`maintenanceOpening`). A kill runs on it,
 * so a kill never waits for a connection the editor's statements hold, except on a connection that serves one session.
 * A catalog the record does not offer is refused before any open (`assertCatalogOffered`).
 */
export async function metadataMaintenanceOpening(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
  catalog: string | undefined,
): Promise<MaintenanceOpening> {
  assertCatalogOffered(engine, catalog, "maintenance");
  const entry = await getOrCreateMetadataSession(connection, engine, editorExecutionContext(session, connection));
  return maintenanceOpening(session, connection, engine, catalog, entry);
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
