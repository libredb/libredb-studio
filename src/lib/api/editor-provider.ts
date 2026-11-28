import { editorExecutionContext } from "@/lib/api/execution-context";
import { requestCatalog, scopeToCatalog } from "@/lib/db/catalog-scope";
import { getOrCreateProvider, readProviderDeclarations } from "@/lib/db";
import {
  type CachedSession,
  findCachedProvider,
  getOrCreateEditorSession,
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
  entrySourceTarget,
  entryTreeTarget,
  type MaintenanceOpening,
  type MonitoringTarget,
  packageMaintenanceOpening,
  providerConsoleTarget,
  providerMaintenanceTarget,
  providerMonitoringTarget,
  type SessionTarget,
  type TreeTarget,
} from "@/lib/api/session-target";
import { HostDefectError } from "@/lib/provider-host/access";
import type { ObjectsSession } from "@/lib/provider-host/core/objects";
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
 * `POST /api/db/query` opens every engine, as `metadataTreeTarget` decides the object tree's session of any record,
 * `editorSourceTarget` the object source read's, `metadataMonitoringTarget` and `editorMonitoringTarget` the monitoring
 * reads' sessions of any record, and `editorMaintenanceOpening` and `metadataMaintenanceOpening` the maintenance
 * requests' sessions of any record, the metadata session for the kill that must not wait for the editor's statements.
 * The cancel, which acts on the whole connection rather than in one database and finds a statement in whichever session
 * runs it, opens through `editorConsoleTarget` below, with no catalog.
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
 * through the same `scopeToCatalog`, as its console target (`providerConsoleTarget` in ./session-target); a provider
 * package's session is answered as its entry's console target (`entryConsoleTarget`), as `editorConsoleTarget` reads
 * it: its declared environment, each call counted on the entry, and the connection's own statement timeout. `wait` is
 * the request's own wait for the open (`openWithinBudget` in src/lib/api/editor-query.ts), handed to the factory as it
 * is.
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
): Promise<ConsoleTarget> {
  const entry = await getOrCreateEditorSession(connection, engine, editorExecutionContext(session, connection), wait);
  const { opened } = entry;
  if (opened.form === "provider") return providerConsoleTarget(await scopeToCatalog(opened.provider, catalog));
  assertNoSessionCatalog(catalog);
  return entryConsoleTarget(entry, connection);
}

/**
 * Refuses `catalog` handed with a provider package's session, which serves no catalog session, as Studio's own defect:
 * every caller refuses a catalog for an engine whose record offers none before any open (`assertCatalogOffered`, which
 * `assertEditorFieldsOffered` reads on the query route), so a catalog reaches a package's session only through a record that offers one, which no
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

/** The request fields of an editor route a record may not offer, by the name a refusal gives each. */
type EditorField = "explain" | "database" | "options.unlimited";

/** The not-sent refusal of `field`, a request field `engine`'s record does not offer, facet `console`. */
function fieldNotOffered(engine: EngineRecord, field: EditorField): FacetNotOfferedError {
  const error = new FacetNotOfferedError(
    `This connection's engine does not offer the request field ${field} in this LibreDB Studio, so Studio opened nothing.`,
    legacyProviderType(engine),
    "console",
    field,
  );
  markNotSent(error);
  return error;
}

/**
 * Refuses the first request field of an editor statement that `engine`'s record does not offer, by name, before the
 * confirmation gate and any open: a plan (`explain`), whose statement is built by the connected provider's strategy,
 * keyed by a legacy plan format; a key-space `database`, read from a legacy provider's declarations; a server-level
 * `catalog`, a legacy catalog session, in `assertCatalogOffered`'s sentence; and an unbounded page
 * (`options.unlimited`), since the provider contract always pumps a bounded one (docs/providers/CONTRACT.md, clause
 * C-16). Each is `FacetNotOfferedError` of facet `console`, its operation the field's name, outcome not-sent. The query
 * and the transaction routes read it after every malformed field's 400: the caller reads `explain` and `database`,
 * and a `catalog` is read here first where the record does not offer catalogs, so a malformed one answers its 400
 * before any field is refused; where the record offers them it is not read here, and keeps its answer where the route
 * reads it. A legacy record offers all four, so it is refused nothing.
 *
 * @throws {DatabaseConfigError} For a malformed `catalog`, on an engine whose record does not offer catalogs.
 * @throws {FacetNotOfferedError} Not-sent, for the first field set that the record does not offer.
 */
export function assertEditorFieldsOffered(
  engine: EngineRecord,
  request: {
    readonly body: Record<string, unknown>;
    readonly explain: boolean;
    readonly database: number | undefined;
    readonly unlimited: boolean;
  },
): void {
  const { offers } = engine;
  const catalog = offers.catalog ? undefined : requestCatalog(request.body);
  if (request.explain && !offers.explain) throw fieldNotOffered(engine, "explain");
  if (request.database !== undefined && !offers.database) throw fieldNotOffered(engine, "database");
  assertCatalogOffered(engine, catalog, "console");
  if (request.unlimited && !offers.unboundedPage) throw fieldNotOffered(engine, "options.unlimited");
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
 * The source target of `connection`'s editor session of `engine`, for any record the server serves: the entry
 * `getOrCreateEditorSession` answers (src/lib/db/factory.ts), opened under the session's editor posture as
 * `editorTarget` opens it, with the same owner and no wait of the request's own, read by its form (`entrySourceTarget`
 * in ./session-target): a legacy provider's bridged session, or a provider package's session with its declared
 * environment, the connection's own statement timeout and each read counted on the entry. The object source route
 * reads one object's source document on it (`handleObjectRequest` in ./object-route).
 */
export async function editorSourceTarget(
  session: { role: string; idpSubject?: string },
  connection: EngineConnection,
  engine: EngineRecord,
): Promise<SessionTarget<ObjectsSession>> {
  const entry = await getOrCreateEditorSession(connection, engine, editorExecutionContext(session, connection));
  return entrySourceTarget(entry, connection);
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
