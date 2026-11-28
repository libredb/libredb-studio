/**
 * Database Provider Factory
 * The entry points that build, cache, tunnel and tear down legacy providers, and the one editor cache every engine's
 * session lives in. Every build opens through its engine's record and the one open function (`openEngine` in
 * @/lib/provider-host/open-engine), whose legacy open (`openLegacyEngine` in @/lib/provider-host/legacy-adapter/open)
 * imports each engine's provider module on demand and constructs its class; this module imports no provider module
 * itself.
 *
 * The editor cache (`providerCache`) holds one entry type for every engine (`CachedSession`): the engine's record, what
 * its open answered in the form `openEngine` answers it (a legacy provider with the factory's facts of it, or a provider
 * package's connected session with its declared environment), the connection, the owner and the frame its key frames,
 * and the idle clock and running count the sweep reads. `getOrCreateEditorSession` is the editor's cached open of any
 * record: a legacy record's through `getOrCreateProvider`'s body, keyed by `editorCacheKey`, and a package's through
 * the package's own `open`, keyed by `package\0<package name>\0<frame>`, the frame `frameCacheKey`
 * (./provider-cache-key) answers, so a legacy and a package's key never meet. Both run through the cache's one open table
 * (clause C-44) under the engine's connect budget (clause C-55). The sweep, a removal, the close of the caches and
 * `getProviderCacheStats` read every entry alike; an entry's teardown is chosen by its form, never by its engine: a
 * legacy provider's rolls back an open transaction and disconnects it, a package's session is closed under a cleanup
 * context with no rollback step (`teardownContractSession` in @/lib/provider-host/core/contract-session), each under
 * the teardown's deadlines (clause C-45). `openEngineOnce` is the same open without the cache, for Test Connection.
 * `getOrCreateMetadataSession` is the metadata cache's open of any record in the same way: a legacy record's through
 * `getOrCreateMetadataProvider`'s body, and a package's through the package's own `open` with the metadata session's
 * pool (clause C-66). The entry points that answer a `DatabaseProvider` (`getOrCreateProvider`,
 * `getOrCreateMetadataProvider`, `acquireExecutionProfileProvider` and the builds) read a record that offers a legacy
 * provider and refuse a package's engine (`legacyProviderEngine` in ./server-catalog); the execution-profile cache
 * holds legacy providers only.
 */

import {
  type DatabaseProvider,
  type DatabaseConnection,
  type EditorExecutionContext,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderOptions,
  type ProviderExecutionContext,
} from "./types";
import { deadlineSignal } from "@libredb/provider-sdk/calls";
import {
  buildPhase,
  ConnectionError,
  connectPhase,
  DatabaseConfigError,
  markNotSent,
  StudioProfileRefusal,
  StudioTimeoutRefusal,
} from "./errors";
import { connectBudgetFor, openDeadlineSentence } from "./connect-budget";
import { errorCode, errorKind } from "./error-record";
import { providerAuthor } from "./operations/provider-text";
import { createSSHTunnel, closeSSHTunnel, releaseUnopenedTunnel, tunnelProviderOpened } from "@/lib/ssh/tunnel";
import type { TunnelInfo } from "@/lib/ssh/tunnel";
import { isEnvelopeClaim } from "@/lib/storage/envelope-claim";
import { frameCacheKey, providerCacheKey, providerOwner } from "./provider-cache-key";
import { assertConnectionIsPlainData, providerFields } from "./provider-connection";
import { decideTunnel } from "./tunnel-decision";
import { supportsQueryCancel } from "./query-cancel";
import { egressDecision } from "./egress-decision";
import { registerOwnerRemoval } from "./owner-removal";
import { sessionCapacity } from "./session-capacity";
import { assertStatementsReviewed } from "./statement-review";
import { clientCapabilities } from "./client-capabilities";
import { IDLE_TIMEOUT_MS, SWEEP_INTERVAL_MS } from "./idle-sweep";
import { type ProviderTextScrub, providerTextScrub, withholdProviderError } from "./operations/provider-text";
import {
  type EngineConnection,
  type EngineRecord,
  legacyProviderEngine,
  offersLegacyProvider,
  servedPackage,
} from "./server-catalog";
import {
  assertClaimsGranted,
  assertOpenable,
  assertOwnerPoolHonoured,
  assertProviderEnabled,
  assertReadOnlyHonoured,
} from "./open-check";
import {
  type OpenedEngine,
  type OpenedPackageSession,
  openedProvider,
  openedSession,
  openEngine,
} from "@/lib/provider-host/open-engine";
import { teardownContractSession } from "@/lib/provider-host/core/contract-session";
import { packageConnectBudget } from "@/lib/provider-host/open-context";
import { enabledProviderTypes } from "./enabled-providers";
import { type DatabaseType, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { logger } from "@/lib/logger";
import { onProviderCacheClose } from "@/lib/shutdown";
import { getAppVersion } from "@/lib/app-version";
import {
  createOpenFlights,
  type DiscardedFlight,
  discardFlights,
  type Flight,
  type OpenDeadline,
  openOnce,
  type OpenWait,
} from "@/lib/provider-host/core/open-once";
import {
  settleWithin,
  TEARDOWN_CLOSE_MS,
  TEARDOWN_ROLLBACK_MS,
  teardownWithin,
} from "@/lib/provider-host/core/teardown";
import * as path from "path";

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create a database provider for a connection, not connected: the engine's record (`legacyProviderEngine` in
 * ./server-catalog), then the one open function (`openEngine` in @/lib/provider-host/open-engine), which runs the one
 * ordered open check and the legacy adapter's open, where the engine's provider module is imported on demand.
 *
 * @param connection - Database connection configuration, plain data. The provider is built from
 *   `providerConnection(connection)` (./provider-connection): a new object holding only the fields the engine declares
 *   (`providerFields`) and core's markers, the tunnel's route under `TUNNEL_ROUTE` for a record that carries a tunnel,
 *   so every tunnel field, its password, private key and passphrase among them, the agent credential and every field
 *   the engine does not declare stay in the record the caller passed; a connection that is not plain data is refused
 *   with a `DatabaseConfigError` and nothing is built. Core's decision about the
 *   tunnel (`decideTunnel` in ./tunnel-decision) is taken before anything is built: a malformed `sshTunnel`, a tunnel
 *   that is on for an engine that takes none or for a connection with no host and port, a tunnel that is on and was not
 *   opened (no `TUNNEL_FAR_END`: build inside `withOneShotTunnel` or use `getOrCreateProvider`), and a far end on a
 *   connection whose tunnel is not on, are each refused with a `DatabaseConfigError` (`assertProviderTunnel`). The process's egress decision is taken first too, where the other entry points call assertEgressDecided: the
 *   first call of a process with no boot hook reads `DB_HTTP_BLOCK_PRIVATE_HOSTS` and keeps it, and an invalid value is
 *   refused on every call. A SQLite, DuckDB or LibreDB connection is then admitted (`admittedFileConnection` in
 *   ./provider-files): the provider is handed, under `ADMITTED_FILE`, the file the connection names resolved against
 *   the working directory of this call, and opens that; `database` and `connectionString` stay as passed. The files
 *   an OPC UA connection's client certificate and private key paths name are admitted the same way
 *   (`admittedHostPathConnection`), under `ADMITTED_HOST_PATHS`; the fields stay as passed. Studio's
 *   storage location (`storageLocation` in @/lib/data-dir) is taken beside the egress decision, so the first call of
 *   a process with no boot hook takes it and keeps it, whatever engine that call builds.
 * @param options - Optional provider options (pooling, timeout, etc.)
 * @param execution - Server-injected execution context (#328, non-admin DuckDB file access). Never built
 *   from caller-supplied options. `acquireExecutionProfileProvider` passes the agent
 *   profile's context as `executionContextFor` builds it, and `getOrCreateProvider` and the routes that build their own
 *   provider pass the editor file-access posture `editorExecutionContext` derived from
 *   the verified session and the resolved connection. What each provider establishes with `readOnly` and
 *   `sendsStatements` is stated once, on `ProviderExecutionContext` (types.ts); DuckDB reads
 *   `allowExternalFileAccess` on its editor handle, and a SQLite connection is refused when it is
 *   `false`, a profiled handle included, here before the provider is built and before the file it names is read
 *   (see `assertOpenable` in ./open-check). On DuckDB, ABSENT MEANS DENY: called without a context, as an
 *   embedder that predates the posture calls it, a DuckDB handle opens with
 *   `enable_external_access: 'false'`, so `read_csv`, `COPY`, `ATTACH` of a file and
 *   `INSTALL` are refused outside its private temp directory and its database's own file
 *   names (docs/providers/duckdb.md section 3.16) while the database stays writable; pass
 *   `{ allowExternalFileAccess: true }` for the full editor reach. SQLite refuses only an explicit
 *   `false`, so called without a context it opens with the trusted reach. An `owner` makes the provider
 *   that user's own (docs/GOVERNANCE.md#per-user-providers): its pool opens with `min: 0` and `max: ownerPoolMax`.
 *   A provider that takes a context is handed a copy of this one with the process's egress decision added, as
 *   `ProviderBuildContext` (types.ts), so no provider reads `DB_HTTP_BLOCK_PRIVATE_HOSTS` itself; an engine whose
 *   record's `connection.readsTrustMaterial` is true, Db2 today, is also handed the trust material core read from
 *   the file `NODE_EXTRA_CA_CERTS` names (./trust-material), and every other engine `trust: undefined`, so no provider
 *   reads that variable or file either. A caller's `egress` or `trust` is never handed on.
 * @returns Promise<DatabaseProvider> instance
 * @throws UnknownProviderError if the connection's type is absent or names no provider, before anything else is
 *   checked, logged or built (FND-1; see `legacyProviderEngine` in ./server-catalog, which refuses an engine only a
 *   provider package serves as `ProviderUnavailableError` or `PackageEngineUnsupportedError` in the same place)
 * @throws DatabaseConfigError if the one ordered open check over the engine's record refuses the connection
 *   (`assertOpenable` in ./open-check, whose docblock states the order): its type is left out of a set
 *   `LIBREDB_ENABLED_PROVIDERS`, its `readOnly` cannot be honoured, an owner comes without a whole `ownerPoolMax`
 *   from 1, the connection or the execution context is not plain data (a class instance, a getter, an inherited field
 *   or a field that is not enumerable), its engine refuses a denied file-access posture and `execution` denies it,
 *   before the file it names is read, its tunnel is refused, it sets a field its engine refuses by name, or the
 *   engine's form entry declares a required secret the connection shows and leaves absent, not text or only
 *   whitespace (Snowflake's private key under Key pair, an absent Sign-in read as Key pair, and its access token under
 *   a programmatic access token), with the entry's sentence for it, which names the field; a provider constructed
 *   directly refuses a blank required secret at `connect()`. Or, for an engine whose record's
 *   `connection.readsTrustMaterial` is true, if the file `NODE_EXTRA_CA_CERTS` names is missing, unreadable, empty,
 *   holds a block under the legacy `X509 CERTIFICATE` label, holds no certificate block or leaves one unclosed
 *   (`Invalid NODE_EXTRA_CA_CERTS: <reason>`, see trustMaterial in ./trust-material): the first such build of a process
 *   with no boot hook reads the file and keeps the outcome, and an invalid file refuses every such build, before the
 *   log line, while every other engine is built as before
 * @throws DatabaseConfigError if a SQLite, DuckDB or LibreDB connection names one of Studio's own storage files, a
 *   path holding a NUL byte, a file name that is not text, a path the reserved check cannot read or, for SQLite, a
 *   connection string with no file after `file:`, before the provider is built (see admittedFileConnection),
 *   if an OPC UA connection's client certificate or private key path names one of Studio's own storage files, holds a
 *   NUL byte, is not text or cannot be checked, naming the field (see admittedHostPathConnection),
 *   or if an OPC UA connection is built while `LIBREDB_OPCUA_PKI_ROOT` is relative (see opcuaPkiRoot)
 *
 * Every error raised while the provider is built, each refusal above and a provider constructor's own, answers `outcome`
 * `not-sent` (`buildPhase` in ./errors): a build sends no statement.
 *
 * @example
 * // `connection` is a saved connection the caller resolved, of an engine whose record offers a legacy provider.
 * const provider = await createDatabaseProvider(connection);
 * await provider.connect();
 * const result = await provider.query(statement);
 * await provider.disconnect();
 */
/**
 * Strip the control characters a log line's framing is made of, so a caller-supplied value
 * cannot write a line of its own.
 *
 * Hoisted out of `createDatabaseProvider`, where it guarded `type` and `name`, once
 * `connection.id` was established to be caller-supplied too (GHSA-3wh2-8x78-jfw4 - see
 * {@link providerCacheKey}). Every site below that INTERPOLATES an id into a message uses it;
 * the ids passed as structured logger FIELDS do not need it, because a field is never parsed
 * as part of the line.
 */
const sanitize = (v: string) => v.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/**
 * Refuse a connection with no id, before the cache key is computed (#1539).
 *
 * The provider's own `validate()` raises `DatabaseConfigError("Connection ID is required")` for this
 * record, but `getOrCreateProvider` and `acquireExecutionProfileProvider` compute their cache key
 * first, and `providerCacheKey` length-frames `connection.id`: a missing id crashed there with a
 * `TypeError`, which `createErrorResponse` answered as a 500 `INTERNAL_ERROR` on every route that
 * opens a cached provider (query, health and multi-query were measured). The same record reaching the
 * provider through `createDatabaseProvider`, as `POST /api/db/test-connection` builds it, was already
 * refused with a 400 `CONFIG_ERROR`. The refusal is raised here instead, as the same
 * `DatabaseConfigError` the provider would have raised, so the key never sees a record the provider
 * would refuse, and no fallback key is invented for a missing id.
 */
function assertConnectionIdPresent(connection: DatabaseConnection): void {
  if (!connection.id) {
    throw new DatabaseConfigError("Connection ID is required", connection.type);
  }
}

/**
 * Take the process's egress decision (`./egress-decision`) before anything is cached, dialled or built, refusing an
 * invalid `DB_HTTP_BLOCK_PRIVATE_HOSTS` with its `DatabaseConfigError`, on every call.
 *
 * The factory is where a channel with no boot hook, the published package and the VS Code backend, takes the decision:
 * its first entry point call reads the variable, logs the decision and keeps it for the life of the process (FND-2,
 * LD9). On a standalone server the boot preflight took it already, so this reads the kept outcome. It runs in
 * `getOrCreateProvider`, `acquireExecutionProfileProvider` and `withOneShotTunnel` beside
 * `assertTunnelRecordIsPlainData`, so `getOrCreateProvider` never dials a bastion for a server whose setting it then
 * refuses; `createDatabaseProvider` takes the decision in its open check (`assertOpenable` in ./open-check) and reads
 * the kept decision after it, since it hands it to the provider.
 */
function assertEgressDecided(): void {
  egressDecision();
}

// ============================================================================
// Enabled providers (LIBREDB_ENABLED_PROVIDERS)
// ============================================================================

// Read in ./enabled-providers, which the SQLite sample shares; the VS Code backend takes it from this factory surface.
export { enabledProviderTypes };

export async function createDatabaseProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: ProviderExecutionContext = {},
): Promise<DatabaseProvider> {
  // The engine's record first, before every other check and the log line: a type that names no provider is refused by
  // name, and no other refusal speaks for it (FND-1). Every later read of the engine is its record's, through the one
  // open function.
  return await buildPhase(async () =>
    openedProvider(
      await openEngine(legacyProviderEngine(connection.type, "open"), {
        connection,
        execution,
        purpose: "connect",
        options,
      }),
    ),
  );
}

/**
 * What Studio reads of a provider it never connects: its capabilities, with the masking exemption Studio's record
 * answers, its labels and whether it can cancel a running statement (`supportsQueryCancel` in ./query-cancel). Plain
 * data, never the provider.
 */
export interface ProviderDeclarations {
  readonly capabilities: ProviderCapabilities;
  readonly labels: ProviderLabels;
  readonly supportsQueryCancel: boolean;
}

/**
 * Read a connection's provider declarations without connecting anything and without opening its SSH tunnel (FND-2
 * slice 5): the read Studio's routes take when they only need to know what a provider declares, such as
 * `POST /api/db/provider-meta`.
 *
 * It runs every check `createDatabaseProvider` runs, so a connection that one refuses for its type, its read-only
 * mode, its execution context or its tunnel (a malformed tunnel, an engine that takes none, a tunnel with nothing to
 * forward to) is refused here by the same sentence, except three: a tunnel that is on and was not opened, a field its
 * engine refuses by name, and a required secret its engine declares left blank (the open check's `"declarations"`
 * purpose, `assertOpenable` in ./open-check), since reading what a connection declares never signs in. It opens the
 * provider from such a connection through the one open function (`openEngine` in @/lib/provider-host/open-engine),
 * reads it and lets it go, so the provider, whose `host` and `port` are the
 * database's own, is never handed out and can never be connected past the tunnel. It is not exported from the package
 * (`src/exports/`); an embedder reads a tunnelled connection's declarations inside `withOneShotTunnel`.
 *
 * Its capabilities are the provider's as `clientCapabilities` (./client-capabilities) answers them: the masking
 * exemption is the `maskingExemptColumns` grant of the connection's engine record, never the provider's own.
 */
export async function readProviderDeclarations(
  connection: DatabaseConnection,
  execution: ProviderExecutionContext = {},
): Promise<ProviderDeclarations> {
  const provider = await buildPhase(async () =>
    openedProvider(
      await openEngine(legacyProviderEngine(connection.type, "open"), {
        connection,
        execution,
        purpose: "declarations",
        options: {},
      }),
    ),
  );
  return {
    capabilities: clientCapabilities(connection.type, provider.getCapabilities()),
    labels: provider.getLabels(),
    supportsQueryCancel: supportsQueryCancel(provider),
  };
}

// ============================================================================
// SSH tunnel rewrite (#457, X23)
// ============================================================================

/**
 * The connection a provider is built with when its traffic goes through an SSH tunnel: `host`
 * and `port` point at the tunnel's LOCAL endpoint, which is where the driver must dial, and the
 * address that endpoint FORWARDS TO, read back off the tunnel, travels with them under
 * `TUNNEL_FAR_END`.
 *
 * The far end is carried because the rewrite alone made the whole tunnelled population unable to
 * edit anything (X23). A provider seals every object edit plan with
 * `connectionFingerprint(this.config)` and the edit routes recompute that digest from the record
 * the request resolved, so a config that says `127.0.0.1:<ephemeral>` and a record that says
 * `db.internal:5432` compared unequal on every attempt: the reader could open the object, could
 * read it, and could never edit it.
 *
 * It is NOT on `ProviderOptions`, for the reason `ProviderExecutionContext`'s docblock already
 * gives about a profile flag: options are caller-supplied and flow all the way into
 * `getOrCreateProvider`, and a value the seal depends on must not be settable by whoever builds
 * the options for a request. A symbol key is the same footing reached differently - see
 * `TUNNEL_FAR_END` in `src/lib/types.ts` for what stops a stored connection carrying one.
 *
 * `base` is the connection as the caller already holds it - `acquireExecutionProfileProvider` has
 * substituted the agent credential onto it by the time it gets here - and only `host` and `port`
 * are replaced. The far end is not read off it at all, which is the point of the paragraph below.
 *
 * THE FAR END COMES OFF THE TUNNEL, never off the record, and that is why this helper takes no
 * separate `farEnd` argument (D86). A pooled tunnel is not always the one this call opened, so
 * the address the caller ASKED to forward to and the address the forward reaches are two
 * different facts. MEASURED 2026-09-15 against the live bastion, no mocks: with the pool keyed
 * on the connection id alone, a provider built on the id of a tunnel to `pg-p3fix:5432` with the
 * record changed to `db-elsewhere.invalid:6543` dialled the existing forward, answered
 * `libredb_dev` at `172.23.0.2`, and sealed `db-elsewhere.invalid:6543` - which is exactly what
 * the edit routes recompute, so that plan verified against a machine the statement never reached.
 * Two things closed it: `TunnelInfo` now carries `remoteHost`/`remotePort`, and the pool keys on
 * them and on the bastion route, so a request for a forward nothing has opened opens its own.
 */
function tunnelledConnection(base: DatabaseConnection, tunnel: TunnelInfo): DatabaseConnection & WithTunnelFarEnd {
  return {
    ...base,
    host: tunnel.localHost,
    port: tunnel.localPort,
    [TUNNEL_FAR_END]: { host: tunnel.remoteHost, port: tunnel.remotePort },
  };
}

/**
 * Release the tunnel that `getOrCreateProvider` or `acquireExecutionProfileProvider` was handed for a provider that did
 * not open: one its constructor refused (MySQL without a database, Apache Cassandra without a local data centre), one
 * its connect failed, or one the acquisition refused before connecting.
 *
 * The tunnel pool decides whether the forward closes (`releaseUnopenedTunnel`): it closes once no other caller is
 * still connecting through it and no provider opened on it. A concurrent connect of the same forward is handed the same
 * forward, so this call alone cannot tell whether a sibling needs it. A forward every caller failed on must be closed
 * here, because nothing else closes it soon. No cache entry holds the provider, so the idle sweep never reaches it; only
 * a disconnect of the connection (`removeProvider`, which closes every forward of an id nothing serves) or the eviction
 * of another entry of the same id would, and a `seed:` connection's disconnect removes nothing without governance. A
 * failure to close is logged through `scrub`, the scrub of the connection the provider was being built for, and does
 * not replace the caller's error, which is the one that says why the provider did not open.
 */
async function releaseTunnelOfUnopenedProvider(
  tunnel: TunnelInfo,
  connectionId: string,
  scrub: ProviderTextScrub,
): Promise<void> {
  try {
    await releaseUnopenedTunnel(tunnel);
  } catch (error) {
    logger.warn(`[DB] Error closing the SSH tunnel of a provider that did not open`, {
      connectionId,
      error: String(withholdProviderError(scrub, error)),
    });
  }
}

// ============================================================================
// One-shot tunnel scope (#457)
// ============================================================================

/**
 * Run `run` against a connection reachable through its SSH tunnel, then close the
 * tunnel unconditionally.
 *
 * This is the transport for a caller that opens a provider outside both provider caches
 * and connects it: Test Connection (`testConnection` in src/lib/api/test-connection.ts,
 * which `POST /api/db/test-connection` and the VS Code extension's `connection/test` share),
 * through the one-shot open (`openEngineOnce`) where the engine's record offers a tunnel.
 * Before #457 it connected to the raw database host, so a tunnelled connection could never
 * be tested and therefore never be saved at all (the dialog gates its only save button on a
 * passing test).
 *
 * The tunnel is deliberately NOT pooled, unlike `getOrCreateProvider`'s. That caller
 * caches nothing, so nothing would ever evict a pooled tunnel: `removeProvider` and the
 * idle sweep close the tunnel of a CACHED provider, and the connection dialog mints a
 * fresh id for every unsaved build - so each test click would strand an SSH client and
 * a listening local server for the life of the process. Ownership sits with this scope
 * instead, which is why `run` is a callback rather than a returned endpoint: the close
 * cannot be forgotten.
 *
 * The callback is NOT named `use`: `react-hooks/rules-of-hooks` reads a call to
 * anything named `use()` as React 19's hook and rejects it outside a component, and
 * inside a try block on top of that.
 *
 * A connection with no tunnel, or with one that is off, passes straight through
 * untouched. A tunnel that is on is decided by core first (`decideTunnel`, the rule the
 * pooled paths apply): one that is malformed, on an engine that takes none, or on a
 * connection with no host and port to forward to (a connection-string connection) is
 * refused before anything is dialled or run.
 */
export async function withOneShotTunnel<T>(
  connection: DatabaseConnection,
  run: (effective: DatabaseConnection) => Promise<T>,
): Promise<T> {
  // First, before the tunnel is dialled: a type that names no provider is refused by name (FND-1). The checks below
  // read the engine's record (./open-check).
  const engine = legacyProviderEngine(connection.type, "open");
  assertProviderEnabled(engine);
  assertReadOnlyHonoured(engine, connection);
  assertClaimsGranted(engine);
  // Before the callback is handed the record or a copy of it: a copy of a record that is not plain data would reach the
  // build as plain data (assertConnectionIsPlainData in ./provider-connection).
  assertConnectionIsPlainData(connection);
  // Core's decision about the tunnel (./tunnel-decision), before the copy below and before anything is dialled: a
  // malformed tunnel, an engine that takes none and a tunnel with nothing to forward to are refused here, by name.
  const tunnelDecision = decideTunnel(connection, engine);
  assertEgressDecided();
  if (!tunnelDecision.open) {
    return await run(connection);
  }

  const tunnel = await createSSHTunnel(connection.id, tunnelDecision.tunnel, tunnelDecision.host, tunnelDecision.port, {
    shared: false,
  });

  try {
    return await run(tunnelledConnection(connection, tunnel));
  } finally {
    // Logged through the connection's scrub, not rethrown: a failing teardown must not replace the caller's error,
    // which is the one that says why the database connection did not work. The scrub reaches every provider of the
    // connection (`"any"`), as the callers build theirs with the connection's own credentials.
    await tunnel.close().catch((error: unknown) => {
      const scrub = providerTextScrub(connection, "any");
      logger.warn(`[DB] Error closing a one-shot SSH tunnel`, {
        connectionId: connection.id,
        error: String(withholdProviderError(scrub, error)),
      });
    });
  }
}

// ============================================================================
// Provider Cache (for connection reuse)
// ============================================================================

/** A legacy provider a cache entry holds, with the factory's facts of it. */
interface HeldProvider {
  readonly form: "provider";
  readonly provider: DatabaseProvider;
  /**
   * The file this entry holds open, when the engine is granted a single-writer file, one that
   * keeps one handle per file - see `findOpenSingleWriterProvider`.
   * `null` on every other engine.
   */
  readonly singleWriterFile?: string | null;
  /**
   * Whether this entry's DuckDB handle was opened with file access allowed (non-admin DuckDB file access): the
   * derived posture `getOrCreateProvider` opened it under. Only the single-writer borrow for
   * DuckDB reads it, so a handle is lent only to a caller of the same posture and nobody is
   * handed a handle wider than its own. It is the derived boolean, so it is `true`/`false`
   * rather than absent, and it is ignored for every engine but DuckDB (the borrow gates on it
   * only there).
   */
  readonly allowExternalFileAccess?: boolean;
  /**
   * The scrub of the connection this entry's provider was built for, of the reach its cache serves (`"any"` for the
   * writable cache, `"profiled"` for the execution-profile cache): every log line about this provider's failure renders
   * the error through it.
   */
  readonly scrub: ProviderTextScrub;
}

/**
 * What a cache entry holds, in the form `openEngine` answers (`OpenedEngine`): a legacy provider with the factory's facts
 * of it, or a provider package's connected session with the package's declared environment. A package's session renders
 * no text through a scrub: its failures are logged by kind and code.
 */
type HeldEngine = HeldProvider | ({ readonly form: "session" } & OpenedPackageSession);

/**
 * An entry of the factory's caches, of every engine alike: what its open answered and what its key, the sweep, a
 * removal and the close read of it. The execution-profile cache holds the provider form only; the metadata cache holds
 * a provider package's session too (`getOrCreateMetadataSession`).
 */
export interface CachedSession {
  readonly opened: HeldEngine;
  /** The record of the engine the entry serves. */
  readonly engine: EngineRecord;
  /**
   * The connection this entry serves. It is NOT the cache key - see
   * {@link providerCacheKey} for why the key may not be a string the caller typed. Every
   * "which entries serve connection X" question matches on this field.
   */
  readonly connectionId: string;
  /**
   * The user this entry was opened for (docs/GOVERNANCE.md#per-user-providers), the `owner` its key frames, or
   * undefined for an entry every caller of the connection shares. Recorded for the reason `connectionId` is: the key is
   * a digest and cannot be read back, so "which entries are this user's" matches on this field. An entry with an owner
   * is torn down when it goes (`teardownEntry`), never only disconnected.
   */
  readonly owner?: string;
  /**
   * The frame of the entry's key, the key `editorCacheKey` answers for the record it was opened for (for a package's
   * session, `frameCacheKey`'s answer): a removal's key scope names an entry of every cache by it.
   */
  readonly frame: string;
  lastUsed: number;
  /** How many calls run on the entry now; the idle sweep keeps an entry with one running. */
  running: number;
}

/**
 * The legacy provider `entry` holds.
 *
 * @throws {Error} A host defect, when `entry` holds a provider package's session: a caller that reads a provider of it.
 */
function heldProvider(entry: CachedSession): HeldProvider {
  if (entry.opened.form !== "provider") {
    throw new Error(
      "The factory's cache holds a provider package's session under this key, and this caller reads a legacy provider of it: a host defect.",
    );
  }
  return entry.opened;
}

const providerCache = new Map<string, CachedSession>();

// ============================================================================
// One open in flight per cache key (docs/providers/CONTRACT.md, clause C-44)
// ============================================================================

/** What an open in flight records about itself, so a removal or a cache close can find it and the log can name it. */
interface OpenMeta {
  readonly connectionId: string;
  /** The owner its key frames, or undefined for an entry every caller shares, as `CachedSession.owner`. */
  readonly owner?: string;
  /** The frame of its key, as `CachedSession.frame`, which a removal's key scope names. */
  readonly frame: string;
  /** Its engine's connect budget (clause C-55), the open's deadline from its start. */
  readonly budget: number;
  /** What a cache close names it by when it is still opening at the cut (`providerName`, `sessionName`). */
  readonly name: string;
}

/**
 * Logs an open that failed after every caller stopped waiting for it, by the connection id and the error's kind and
 * code, never its text, which may carry what the provider said. The open admitted nothing, so nothing else is left to
 * do. A caller leaves an open through a wait of its own, `getOrCreateProvider`'s fourth argument, which the editor's
 * query and cancel pass, and every caller is answered when the open's deadline ends it (`OPEN_DEADLINE`), after which
 * the open, once its connect settles, closes what it opened and fails as overtaken; exported for the tests.
 */
export function logUnclaimedOpen(error: unknown, flight: Flight<OpenMeta>): void {
  const id = flight.meta.connectionId;
  logger.warn(
    `[DB] An open of ${sanitize(id)} failed after every caller stopped waiting for it, so nothing was admitted.`,
    {
      connectionId: id,
      kind: errorKind(error),
      code: errorCode(error),
    },
  );
}

/**
 * What an open its engine's connect budget ended answers every caller still waiting: this bundle's
 * `StudioTimeoutRefusal`, naming the budget, marked not-sent, since no statement was sent.
 */
function openExpired(flight: Flight<OpenMeta>): StudioTimeoutRefusal {
  const error = new StudioTimeoutRefusal(openDeadlineSentence(flight.meta.budget));
  markNotSent(error);
  return error;
}

/**
 * The deadline of every open of every cache (docs/providers/CONTRACT.md, clause C-55): its engine's connect budget from
 * the open's start, which each open records (`connectBudgetFor` in src/lib/db/connect-budget.ts for a legacy engine,
 * `packageConnectBudget` for a package's). At it every caller still waiting is answered `openExpired`, the next call
 * opens afresh, and the open, once its connect settles, closes what it opened (`connectUnlessOvertaken`,
 * `openCachedSession`).
 */
const OPEN_DEADLINE: OpenDeadline<OpenMeta> = {
  signal: (meta) => deadlineSignal(Date.now() + meta.budget),
  expired: openExpired,
};

/**
 * The opens in flight of the writable cache, of the execution-profile cache and of the metadata cache, one table each,
 * by the key the cache holds what they open under (src/lib/provider-host/core/open-once.ts). Module state of this copy
 * of the factory, as the caches are: each Next.js bundle that loads the factory keeps its own caches and its own opens.
 *
 * Concurrent first calls for one key share one open, so a connection is built, connected and cached once whatever the
 * number of callers: two handles on one DuckDB file, the second replacing the first in the cache, lost a committed row
 * when the first closed. Each open admits its own provider into its cache, and checks after its connect whether a
 * removal or a cache close overtook it (`connectUnlessOvertaken`).
 */
const editorFlights = createOpenFlights<CachedSession, OpenMeta>(logUnclaimedOpen, OPEN_DEADLINE);
const profiledFlights = createOpenFlights<CachedSession, OpenMeta>(logUnclaimedOpen, OPEN_DEADLINE);
const metadataFlights = createOpenFlights<CachedSession, OpenMeta>(logUnclaimedOpen, OPEN_DEADLINE);

/**
 * How many closes of the caches (`closeCaches`) are running. An open that settles while one runs is overtaken as one in
 * flight when it began is: a close states that nothing stays open after it, and its teardown takes up to 15 s, during
 * which a new open would otherwise be admitted and then outlive the close (`connectUnlessOvertaken`).
 */
let cacheClosesRunning = 0;

/**
 * The overtaken opens that connected and are closing what they opened (`connectUnlessOvertaken`), so a cache close that
 * cuts its wait for one names the state it is in (`overtakenOpenStillOpening`). Weak, so a settled flight leaves it.
 */
const flightsClosing = new WeakSet<Flight<OpenMeta>>();

/** What a caller whose open a removal or a cache close overtook is answered, as a `ConnectionError` marked not-sent. */
const OVERTAKEN_OPEN =
  "The connection was closed while it was opening: a disconnect, a removal, a change of access or a shutdown closed it before it was ready, so nothing was sent to the database. Try again.";

/**
 * Connects `provider`, then checks whether a removal or a cache close overtook its open (`flight.signal`, or a close of
 * the caches still running, `cacheClosesRunning`) and, when none did, runs `admit`, which puts the provider into its
 * cache. Nothing is awaited between the check and `admit`, so a
 * removal or a cache close whose synchronous part ran at any point before the admission is seen by the check, and one
 * that runs after it finds the provider in the cache and closes it there (docs/providers/CONTRACT.md, clause C-44).
 * An overtaken open closes the provider it built, once and within the teardown's close deadline, and rejects with a
 * `ConnectionError`, which `connectPhase` marks not-sent and after which the caller releases its tunnel as for a failed
 * connect, so nothing is admitted. A connect that fails rejects with its own error, and nothing is closed.
 */
async function connectUnlessOvertaken(
  provider: DatabaseProvider,
  flight: Flight<OpenMeta>,
  admit: () => void,
): Promise<void> {
  await provider.connect();
  if (!flight.signal.aborted && cacheClosesRunning === 0) {
    admit();
    return;
  }
  const id = flight.meta.connectionId;
  flightsClosing.add(flight);
  const outcome = await teardownWithin({ close: () => provider.disconnect() }, TEARDOWN_DEADLINES);
  if (outcome.close !== "done") {
    const how = outcome.close === "timed-out" ? `did not finish within ${TEARDOWN_CLOSE_MS} ms` : "failed";
    logger.warn(
      `[DB] A provider of ${sanitize(id)} that was closed while it was opening did not close: its disconnect ${how}.`,
      {
        connectionId: id,
        ...(outcome.close === "failed"
          ? { kind: errorKind(outcome.closeError), code: errorCode(outcome.closeError) }
          : {}),
      },
    );
  }
  throw new ConnectionError(OVERTAKEN_OPEN, provider.type);
}

/**
 * The provider `cache` holds under `key` for `connection`, when it may be handed out: connected, and opened with the
 * connection's query timeout. An entry opened with another query timeout is disconnected and dropped, so a saved
 * timeout change reaches the next query even while the connection is open, and null is answered, as for no entry.
 */
async function reusableEntry(
  cache: Map<string, CachedSession>,
  key: string,
  connection: DatabaseConnection,
): Promise<CachedSession | null> {
  const cached = cache.get(key);
  if (cached === undefined) return null;
  const held = heldProvider(cached);
  if (held.provider.config.queryTimeout !== connection.queryTimeout) {
    try {
      await held.provider.disconnect();
    } catch (error) {
      logger.warn(`[DB] Error disconnecting provider after query timeout change`, {
        connectionId: connection.id,
        error: String(withholdProviderError(held.scrub, error)),
      });
    }
    cache.delete(key);
    return null;
  }
  if (held.provider.isConnected()) {
    cached.lastUsed = Date.now();
    return cached;
  }
  return null;
}

/**
 * The open under `key` in `flights`, shared with every concurrent caller (`openOnce`), for `connection`. A caller that
 * joined an open of a connection with another query timeout is not handed that provider: it re-reads the cache once,
 * which takes the timeout path of `reusableEntry`, and then opens at most once more, so no caller loops. With `wait`,
 * the caller stops waiting for either open when `wait.signal` aborts, with its reason, and the open goes on for the
 * others and admits itself.
 */
async function sharedOpen(
  cache: Map<string, CachedSession>,
  flights: typeof editorFlights,
  key: string,
  connection: DatabaseConnection,
  meta: OpenMeta,
  open: (flight: Flight<OpenMeta>) => Promise<CachedSession>,
  wait?: OpenWait,
): Promise<CachedSession> {
  const shared = await openOnce(flights, key, meta, open, wait);
  if (heldProvider(shared).provider.config.queryTimeout === connection.queryTimeout) return shared;
  return (await reusableEntry(cache, key, connection)) ?? openOnce(flights, key, meta, open, wait);
}

/**
 * The name a not-closed list gives a legacy provider: its connection id, its author as a fence names it
 * (`providerAuthor`) and Studio's version when the build reports one (`getAppVersion`).
 */
function providerName(connectionId: string, type: DatabaseType): string {
  const version = getAppVersion();
  const release = version === null ? "" : ` ${version}`;
  return `${sanitize(connectionId)} (${providerAuthor(type)}${release})`;
}

/** The name a not-closed list gives a provider package's session: its connection id, and its package as its author. */
function sessionName(connectionId: string, engine: EngineRecord): string {
  const served = servedPackage(engine);
  return `${sanitize(connectionId)} (${served.name} ${served.version})`;
}

/** The name a not-closed list gives `entry`, by its form. */
function entryName(entry: CachedSession): string {
  return entry.opened.form === "provider"
    ? providerName(entry.connectionId, entry.opened.provider.type)
    : sessionName(entry.connectionId, entry.engine);
}

// ============================================================================
// Single-writer file reuse (#498)
// ============================================================================

/**
 * The identity of a database FILE: the engine type plus the resolved absolute path.
 *
 * The path is what identifies the open handle, not the connection id, because the
 * second opener is usually a different connection record pointing at the same file -
 * which is exactly how D3 reproduced (the built-in "Sample (LibreDB)" holds the file
 * while the dialog tests the edited copy under a fresh id). The type is in the key so
 * two engines can never collide over one path.
 *
 * `null` when the connection carries no file path at all, which is every
 * client-server connection, every connection-string one, and every ANONYMOUS
 * IN-MEMORY one.
 *
 * That last case is not a nicety. `path.resolve(":memory:")` is a path in the working
 * directory, so two unrelated in-memory connections came out with ONE identity and the
 * second borrowed the first's open handle - reading a database nobody pointed it at.
 * It fires on the engines granted a single-writer file, which is where the borrow
 * lives: DuckDB accepts `:memory:` (LibreDB does not). An anonymous in-memory database
 * is per-handle by definition - there is no file to share, no lock to work around, and
 * therefore nothing a borrow could buy.
 *
 * The comparison is EXACT, matching `admittedFileConnection` in `./provider-files`
 * character for character: the admission treats `:memory:` and nothing else as
 * in-memory, and resolves every other spelling - `:MEMORY:`, ` :memory:`, DuckDB's own
 * `:memory:named` - as a relative file path, which is the file the provider opens. Two
 * connections spelling one of those the same way really do point at one file, and must
 * keep matching. The narrowing here is only ever as wide as the provider's own reading
 * of the value.
 */
const ANONYMOUS_IN_MEMORY_DATABASE = ":memory:";

function fileIdentity(connection: EngineConnection): string | null {
  if (!connection.database) return null;
  if (connection.database === ANONYMOUS_IN_MEMORY_DATABASE) return null;
  return `${connection.type}::${path.resolve(connection.database)}`;
}

/**
 * The connected provider that already holds this connection's file, if there is one.
 *
 * Only an engine granted a single-writer file ever registers a file identity here
 * (`getOrCreateProvider` below), read from that grant and never from the built
 * provider's own `singleWriterFile` (docs/providers/CONTRACT.md, clause M-57), so a match means the
 * engine admits ONE handle per file and the caller's alternative is not a second,
 * lesser handle - it is no handle at all. Borrowers must NOT disconnect what they get
 * back: the returned provider is owned by the writable cache and serves the user's
 * live connection.
 *
 * Deliberately reads only the writable cache. The reverse direction - handing an
 * editor request a provider opened under an execution profile - stays forbidden, so
 * profiled entries are not offered here.
 *
 * POSTURE-AWARE FOR DUCKDB (non-admin DuckDB file access). A DuckDB entry records the file-access posture it was
 * opened under, and a borrow matches only an entry opened under the caller's own posture, so a
 * caller is never lent a handle wider than its own. Both sides are normalised to `=== true`, so
 * an absent caller posture (no argument) reads as deny, matching the default
 * `getOrCreateProvider` records and keeping the fail-closed polarity. The gate is skipped for
 * every other engine (libredb), where no such posture exists, so their borrow is unchanged.
 * Under `editorExecutionContext` every role that can resolve one seed record gets the same
 * posture, so on a seed the gate never splits one record between two handles. When it finds
 * nothing to lend while the file is open, `isSingleWriterFileOpen` says so, and Test Connection
 * opens a read-only handle rather than a second read-write one.
 *
 * The cost of that is real and is paid by the editor. If an operations acquisition reaches
 * a single-writer connection nobody has browsed yet, `acquireExecutionProfileProvider`
 * opens the file and caches the handle under the PROFILED key; on LibreDB that handle
 * takes the writer lock, so `getOrCreateProvider` then fails on it, and browsing that
 * connection in the sidebar is refused until the profiled entry is evicted (30 minutes
 * idle). Lifting it would mean serving an editor request a provider opened under an
 * execution profile, which is the isolation invariant `acquireExecutionProfileProvider`
 * exists to keep - so the lockout is the chosen side of that trade, not an oversight.
 * An acquisition that sends statements never takes the lock: LibreDB opens it through
 * its read-only file adapter, beside the writer and before it.
 */
export function findOpenSingleWriterProvider(
  connection: EngineConnection,
  allowExternalFileAccess?: boolean,
): DatabaseProvider | null {
  const identity = fileIdentity(connection);
  if (identity === null) return null;
  // Normalised so an absent caller posture reads as deny, matching the default entries
  // `getOrCreateProvider` records; the gate below only consults it for DuckDB.
  const wantAccess = allowExternalFileAccess === true;
  for (const { opened: held } of providerCache.values()) {
    // A provider package's session holds no file Studio admitted, so it is never lent.
    if (held.form !== "provider" || held.singleWriterFile !== identity || !held.provider.isConnected()) continue;
    // A handle of an engine that opens under a file-access posture is borrowable only by a caller of
    // its own posture (the non-admin DuckDB file-access change). The engine's record, its
    // `grants.readsFileAccessPosture`, answers which engines, so this is not a `connection.type` branch (CLAUDE.md);
    // today DuckDB and SQLite do, and of the two only DuckDB is a single-writer engine.
    if (
      legacyProviderEngine(connection.type, "open").grants.readsFileAccessPosture &&
      (held.allowExternalFileAccess === true) !== wantAccess
    ) {
      continue;
    }
    return held.provider;
  }
  return null;
}

/**
 * Whether a connected handle in the writable cache holds this connection's file, whatever
 * file-access posture it was opened under (non-admin DuckDB file access).
 *
 * `findOpenSingleWriterProvider` answers only with a handle of the caller's own posture, so when it
 * answers null and this answers true, the file is held by a DuckDB handle of the OTHER posture. A
 * caller that would otherwise open its own read-write handle there must not: DuckDB serves one file
 * through one read-write handle per process, and a second one keeps its own copy of the catalog and
 * checkpoints it over the file when it closes, which loses the other handle's committed rows on Linux
 * and macOS and is refused outright on Windows. Test Connection opens a read-only handle instead,
 * which leaves the writer's file and write-ahead log alone (`src/lib/api/test-connection.ts`).
 */
export function isSingleWriterFileOpen(connection: EngineConnection): boolean {
  const identity = fileIdentity(connection);
  if (identity === null) return false;
  return Array.from(providerCache.values()).some(
    ({ opened: held }) => held.form === "provider" && held.singleWriterFile === identity && held.provider.isConnected(),
  );
}

// ============================================================================
// Execution-profile provider cache (#328)
// ----------------------------------------------------------------------------
// Physically separate from providerCache on purpose: an agent acquisition must
// be able to prove it never read from nor wrote to the shared writable cache.
// Keyed by (connection id, execution profile), plus the requester's posture for SQLite and DuckDB.
// ============================================================================

const profiledProviderCache = new Map<string, CachedSession>();

/**
 * The profiled cache's key, which is the shared cache's key with the profile framed onto it
 * (GHSA-3wh2-8x78-jfw4). It used to be `${profile}::${connection.id}`, so it carried the same
 * forgeable id and was reachable by the same forgery - reproduced on this path too, in
 * `tests/isolated/factory.test.ts`. {@link providerCacheKey} states the whole argument.
 *
 * The profile stays in the key because the two caches' isolation is per profile: an
 * `agent-read-only` acquisition may never be served what `agent-operations` opened.
 *
 * The requester's file-access posture is in it too, for an engine that reads one, exactly as in
 * the writable key: a denied SQLite requester is refused before its provider is built, so a handle a trusted
 * requester opened must never answer a denied requester's key. Absent reads as denied. So is the requester's
 * owner (docs/GOVERNANCE.md#per-user-providers), as in the writable key: one user's acquisition is never served
 * another's.
 *
 * Exported for the tests, which name a profiled entry by it; the factory keys its acquisitions and their opens in
 * flight with it.
 */
export async function profiledCacheKey(
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  requester: EditorExecutionContext = {},
): Promise<string> {
  const key = await providerCacheKey(connection, requester.allowExternalFileAccess === true, requester.owner);
  return withProfile(profile, key);
}

/**
 * `key`, a key of the writable cache, with `profile` framed onto it: the key the profiled cache holds the entry of that
 * profile under. {@link profiledCacheKey} keys an acquisition with it, and it frames the metadata session's key too,
 * with `METADATA_FRAME` onto the editor's key, in a cache of its own. Each such entry records the editor's key it framed
 * as its `frame`, by which the key scope of `removeProvider` names it.
 */
function withProfile(profile: string, key: string): string {
  return `${profile.length}:${profile}${key}`;
}

// ============================================================================
// The metadata cache (docs/providers/CONTRACT.md, clause C-66)
// ----------------------------------------------------------------------------
// Each connection's metadata session, beside its editor's, so a tree, monitoring or health read, or a kill, never waits
// for the editor's statements: a legacy provider (`getOrCreateMetadataProvider`) or a provider package's session
// (`getOrCreateMetadataSession`).
// Physically separate from both caches above, as the profiled cache is, so `getProviderCacheStats` keeps answering
// the editor cache's sessions only, a provider package's among them. Keyed by the editor's key with `METADATA_FRAME`
// framed onto it.
// ============================================================================

const metadataProviderCache = new Map<string, CachedSession>();

/**
 * The frame the metadata session's key carries onto the editor's key (`withProfile`), so it frames the same connection
 * fingerprint, credentials, file-access posture and owner as the editor's entry beside it. No execution profile is
 * named `metadata`, and the caches are separate maps.
 */
const METADATA_FRAME = "metadata";

/**
 * The most sessions a metadata session's pool holds, which opens with `min: 0`, so an idle one holds no database
 * connection, and keeps the pool's other defaults. Measured on PostgreSQL 18 at a 50 ms round trip, a warm burst of
 * eight tree reads took 418 ms on one connection, 209 ms on two, 158 ms on three and 106 ms on four: the second
 * connection saves the most, and each further one is a database session per connection per owner. Under governance an
 * owned metadata session opens with this size too, whatever `provider.poolMaxPerUser` says (docs/GOVERNANCE.md). A
 * provider package's metadata session asks its open for the same pool (`PACKAGE_METADATA_PLACE`).
 */
const METADATA_POOL_MAX = 2;

/**
 * Where a writable session is cached and opened: the editor's, or the connection's metadata session, which
 * `getOrCreateMetadataProvider` opens for a connection of session capacity class several (`sessionCapacity`).
 */
interface WritableSession {
  readonly cache: Map<string, CachedSession>;
  readonly flights: typeof editorFlights;
  /** The key the session caches under, from the editor's key. */
  readonly key: (editorKey: string) => string;
  /** The pool size the session opens with, shared or owned, or undefined for the caller's own and the owner's share. */
  readonly poolMax: number | undefined;
}

const EDITOR_SESSION: WritableSession = {
  cache: providerCache,
  flights: editorFlights,
  key: (editorKey) => editorKey,
  poolMax: undefined,
};

const METADATA_SESSION: WritableSession = {
  cache: metadataProviderCache,
  flights: metadataFlights,
  key: (editorKey) => withProfile(METADATA_FRAME, editorKey),
  poolMax: METADATA_POOL_MAX,
};

/** True when any provider, shared, profiled or metadata, still serves this connection. */
function connectionStillServed(connectionId: string): boolean {
  return [providerCache, profiledProviderCache, metadataProviderCache].some((cache) =>
    Array.from(cache.values()).some((entry) => entry.connectionId === connectionId),
  );
}

// ============================================================================
// Teardown of a provider under fixed deadlines (docs/GOVERNANCE.md#per-user-providers;
// docs/providers/CONTRACT.md, clause C-45)
// ============================================================================

/** How the log lines name a provider of each cache: the writable cache's, the profiled cache's and the metadata cache's. */
type CacheNoun = "provider" | "profiled provider" | "metadata provider";

/** The deadlines every teardown runs under, the host core's (src/lib/provider-host/core/teardown.ts). */
const TEARDOWN_DEADLINES = { rollbackMs: TEARDOWN_ROLLBACK_MS, closeMs: TEARDOWN_CLOSE_MS } as const;

/** The interactive transaction session that `POST /api/db/transaction` drives, on a provider that implements one. */
interface TransactionSession {
  isInTransaction(): boolean;
  rollbackTransaction(): Promise<void>;
}

/** The provider's transaction session while it holds a transaction open, or null. */
function openTransaction(provider: DatabaseProvider): TransactionSession | null {
  const session = provider as DatabaseProvider & Partial<TransactionSession>;
  if (typeof session.isInTransaction !== "function" || typeof session.rollbackTransaction !== "function") return null;
  return session.isInTransaction() ? (session as TransactionSession) : null;
}

/**
 * The rollback step of a teardown of `provider`: its open transaction's rollback, none when it holds no transaction,
 * and a failed step when reading its transaction state throws, so a provider that throws there is still closed.
 */
function rollbackStep(provider: DatabaseProvider): (() => Promise<void>) | undefined {
  try {
    const session = openTransaction(provider);
    return session === null ? undefined : () => session.rollbackTransaction();
  } catch (error) {
    return () => Promise.reject(error);
  }
}

/**
 * Tear down a cached provider under the host core's deadlines (`teardownWithin`): an owned provider
 * (docs/GOVERNANCE.md#per-user-providers), closed because its user's access changed, it went idle or the caches close,
 * and a provider every caller shares, closed because the caches close. Its entry is deleted from `cache` first, so no
 * request is handed the provider while it closes; an open transaction is rolled back, waited for at most
 * TEARDOWN_ROLLBACK_MS; and the provider is disconnected, waited for at most TEARDOWN_CLOSE_MS. The rollback comes first
 * because the disconnect would otherwise wait on the very session the transaction holds: `pg`'s `pool.end()` waits for
 * every checked-out client.
 *
 * A rollback or a disconnect that fails is logged with the error rendered through the entry's scrub, and a disconnect
 * that does not finish in time is logged and its pool abandoned, because a client stuck in a statement, or in a
 * rollback that never answered, never comes back. Each step is logged when it ends. So the teardown ends within 15 s
 * whatever the database does, and it never rejects. It answers whether the provider closed completely: false after any
 * of those, which the shutdown counts (`closeCaches`).
 *
 * The lines name an owned provider as before owners shared this path. A shared provider's rollback and cut name it
 * shared, and its failed disconnect keeps the line `closeCaches` always wrote for it, `[DB] Error disconnecting
 * <noun>` with the error, its name and message through the entry's scrub, as an argument, where `noun` names the cache.
 */
async function teardownProvider(
  cache: Map<string, CachedSession>,
  key: string,
  entry: CachedSession,
  noun: CacheNoun = "provider",
): Promise<boolean> {
  cache.delete(key);
  const { provider, scrub } = heldProvider(entry);
  const id = entry.connectionId;
  const shared = entry.owner === undefined;
  const whose = shared ? "a shared provider" : "an owned provider";
  const outcome = await teardownWithin(
    {
      rollback: rollbackStep(provider),
      rollbackEnded: (settled) => {
        if (settled.state === "done") {
          const line = `[DB] Rolled back the open transaction of ${whose} of ${sanitize(id)} before closing it.`;
          logger.info(line, { connectionId: id });
        } else if (settled.state === "timed-out") {
          logger.warn(
            `[DB] The open transaction of ${whose} of ${sanitize(id)} did not roll back within ${TEARDOWN_ROLLBACK_MS} ms, so the provider is closed with it open.`,
            { connectionId: id },
          );
        } else {
          logger.warn(
            `[DB] The open transaction of ${whose} of ${sanitize(id)} failed to roll back, so the provider is closed with it open.`,
            { connectionId: id, error: String(withholdProviderError(scrub, settled.error)) },
          );
        }
      },
      close: () => provider.disconnect(),
    },
    TEARDOWN_DEADLINES,
  );
  if (outcome.close === "timed-out") {
    logger.warn(
      `[DB] Abandoned the pool of ${shared ? "shared" : "owned"} provider ${sanitize(id)}: its disconnect did not finish within ${TEARDOWN_CLOSE_MS} ms.`,
      { connectionId: id },
    );
  } else if (outcome.close === "failed" && shared) {
    // The id is an argument, never part of the first one: `console.error`'s first argument
    // is a format string, and a constant cannot be a format attack (js/tainted-format-string).
    console.error(
      `[DB] Error disconnecting ${noun}`,
      sanitize(id),
      String(withholdProviderError(scrub, outcome.closeError)),
    );
  } else if (outcome.close === "failed") {
    logger.warn(`[DB] Error disconnecting owned provider ${sanitize(id)}`, {
      connectionId: id,
      error: String(withholdProviderError(scrub, outcome.closeError)),
    });
  }
  return (outcome.rollback === "none" || outcome.rollback === "done") && outcome.close === "done";
}

/**
 * Closes `opened`, a provider package's session of `connectionId`, under the teardown's deadlines with no rollback step
 * (`teardownContractSession`), and answers whether it closed: a close cut at the deadline or failed is logged by its
 * connection, kind and code, never its text.
 */
async function teardownSession(connectionId: string, opened: OpenedPackageSession): Promise<boolean> {
  const outcome = await teardownContractSession(opened.session, opened.env);
  if (outcome.close === "done") return true;
  logger.warn(
    outcome.close === "timed-out"
      ? `[DB] A provider package's session of ${sanitize(connectionId)} did not close within ${TEARDOWN_CLOSE_MS} ms, so it is given up.`
      : `[DB] A provider package's session of ${sanitize(connectionId)} failed to close.`,
    {
      connectionId,
      ...(outcome.close === "failed" && { kind: errorKind(outcome.closeError), code: errorCode(outcome.closeError) }),
    },
  );
  return false;
}

/**
 * Tears `entry` down by its form, never by its engine, and answers whether it closed completely: a legacy provider
 * through `teardownProvider`, a provider package's session through `teardownSession`, its entry deleted from `cache`
 * first in both, so no request is handed it while it closes.
 */
async function teardownEntry(
  cache: Map<string, CachedSession>,
  key: string,
  entry: CachedSession,
  noun: CacheNoun = "provider",
): Promise<boolean> {
  if (entry.opened.form === "provider") return teardownProvider(cache, key, entry, noun);
  cache.delete(key);
  return teardownSession(entry.connectionId, entry.opened);
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Whether an idle entry's provider reports a run in flight, so the sweep keeps it for the next sweep.
 * A throw is the provider's defect: logged at error through `scrub`, and the entry is evicted as one without the method, because
 * rethrowing would abandon the rest of the sweep and reading it as busy would let such a provider pin its entry.
 */
function keepsRunInFlight(
  provider: DatabaseProvider,
  scrub: ProviderTextScrub,
  id: string,
  noun: `idle ${CacheNoun}`,
): boolean {
  if (provider.hasRunsInFlight === undefined) return false;
  try {
    return provider.hasRunsInFlight() === true;
  } catch (error) {
    logger.error(
      `[DB] hasRunsInFlight() threw for ${noun} ${sanitize(id)}, so it is evicted as idle.`,
      withholdProviderError(scrub, error),
      { connectionId: id },
    );
    return false;
  }
}

/**
 * Evicts the entries of `cache` idle for at least `maxIdleMs` at `now`, and answers how many it evicted. An entry with a
 * call running on it (`running`), or whose provider reports a run in flight (`keepsRunInFlight`), is kept for the next
 * sweep. An owned entry (docs/GOVERNANCE.md#per-user-providers) and a provider package's session are torn down
 * (`teardownEntry`), so an open transaction a provider still holds is rolled back, a pool that hangs is abandoned and a
 * session's close is cut at its deadline; a legacy provider every caller shares is disconnected, and a failed
 * disconnect is logged through the entry's scrub. The connection's SSH tunnel is closed once nothing serves the connection
 * (`connectionStillServed`), since it is shared per connection id by every cache. Each line names the provider by
 * `noun`, with its idle minutes when `showsIdleMinutes`.
 */
async function evictIdleEntries(
  cache: Map<string, CachedSession>,
  noun: CacheNoun,
  showsIdleMinutes: boolean,
  now: number,
  maxIdleMs: number,
): Promise<number> {
  let evicted = 0;
  for (const [key, entry] of cache) {
    if (now - entry.lastUsed < maxIdleMs) continue;
    const id = entry.connectionId;
    const idle = showsIdleMinutes ? ` (idle ${Math.round((now - entry.lastUsed) / 60000)}min)` : "";
    const held = entry.opened;
    if (
      entry.running > 0 ||
      (held.form === "provider" && keepsRunInFlight(held.provider, held.scrub, id, `idle ${noun}`))
    ) {
      logger.info(
        `[DB] Keeping idle ${noun} ${sanitize(id)}${idle}: it reports a run in flight, so the next sweep checks it again.`,
      );
      continue;
    }
    logger.info(`[DB] Evicting idle ${noun}: ${sanitize(id)}${idle}`);
    if (held.form === "session" || entry.owner !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- the tunnel below may close only once this entry has closed.
      await teardownEntry(cache, key, entry);
    } else {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the tunnel below may close only once this provider has closed.
        await held.provider.disconnect();
      } catch (error) {
        logger.warn(`[DB] Error disconnecting idle ${noun} ${sanitize(id)}`, {
          connectionId: id,
          error: String(withholdProviderError(held.scrub, error)),
        });
      }
      cache.delete(key);
    }
    // Close the shared tunnel only when nothing serves the connection anymore: a live entry of another cache still
    // needs it, and so does another entry of this connection opened with different credentials.
    if (!connectionStillServed(id)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the sweep closes one provider and tunnel at a time, not a burst.
        await closeSSHTunnel(id);
      } catch {
        /* ignore */
      }
    }
    evicted++;
  }
  return evicted;
}

/**
 * Evict providers that have been idle longer than maxIdleMs, from the writable cache, the execution-profile cache and
 * the metadata cache in turn, each on its own idle clock (`evictIdleEntries`).
 * Called by the periodic sweep timer, but also exported for direct testing.
 *
 * @returns number of evicted providers
 */
export async function evictIdleProviders(maxIdleMs: number = IDLE_TIMEOUT_MS): Promise<number> {
  const now = Date.now();
  const editors = await evictIdleEntries(providerCache, "provider", true, now, maxIdleMs);
  const profiled = await evictIdleEntries(profiledProviderCache, "profiled provider", false, now, maxIdleMs);
  const metadata = await evictIdleEntries(metadataProviderCache, "metadata provider", true, now, maxIdleMs);

  // Stop sweeping once every cache is empty
  if (providerCache.size === 0 && profiledProviderCache.size === 0 && metadataProviderCache.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return editors + profiled + metadata;
}

function startIdleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void evictIdleProviders();
  }, SWEEP_INTERVAL_MS);
  // Allow process to exit even if timer is running
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref();
  }
}

/**
 * The owner fields a cached provider is built with (docs/GOVERNANCE.md#per-user-providers): the owner its key frames
 * and the requester's pool size, or nothing for a provider every caller shares, so a context without an owner reaches
 * the provider exactly as it did before owners existed. `owner` is what `providerOwner` answered for the connection.
 */
function ownerContext(owner: string | undefined, requester: EditorExecutionContext): EditorExecutionContext {
  return owner === undefined ? {} : { owner, ownerPoolMax: requester.ownerPoolMax };
}

/**
 * Get or create a database provider with caching
 * Useful for API routes to reuse connections
 *
 * @param connection - Database connection configuration
 * @param options - Optional provider options
 * @param execution - The DuckDB editor file-access posture (non-admin DuckDB file access), and under governance the
 *   owner of a per-user provider (docs/GOVERNANCE.md#per-user-providers), and nothing else. Studio's
 *   routes derive it with `editorExecutionContext` from the verified session and the resolved
 *   connection. ABSENT MEANS DENY: called without it, as an embedder that predates the posture
 *   calls it, a DuckDB handle opens with `enable_external_access: 'false'`, so `read_csv`,
 *   `COPY`, `ATTACH` of a file and `INSTALL` are refused outside its private temp directory and
 *   its database's own file names (docs/providers/duckdb.md section 3.16) while the database
 *   stays writable. Pass
 *   `{ allowExternalFileAccess: true }` for the full editor reach. A denied SQLite connection is refused before its
 *   provider is built, since its drivers cannot confine a statement's file access; every other engine ignores it.
 *   With an `owner`, the provider is that user's own: cached apart from every other user's, opened
 *   with the pool of `ownerPoolMax`, and its entry records the owner; an engine that keeps one handle
 *   per file shares that handle whatever the owner (`providerOwner`).
 *   A `readOnly` in it is refused (`DatabaseConfigError`): this cache holds writable providers,
 *   and a read-only one comes from `createDatabaseProvider` or an execution profile.
 * @param wait - The caller's own wait for the open (docs/providers/CONTRACT.md, clause C-44): when `wait.signal`
 *   aborts, this call rejects with its reason, by reference, and the open goes on for every other caller, admits its
 *   provider into the cache once, or, when it fails with no caller left, is logged by its connection, kind and code
 *   (`logUnclaimedOpen`). A signal already aborted rejects before any open is started or joined. The checks, the cache
 *   key and a cached entry's reuse run before the open and are not bounded by it. Without it the call waits until the
 *   open settles.
 * @returns Cached or new DatabaseProvider instance
 * @throws UnknownProviderError if the connection's type is absent or names no provider, before the cache key, the
 *   lookup and any tunnel (FND-1)
 */
export async function getOrCreateProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: EditorExecutionContext = {},
  wait?: OpenWait,
): Promise<DatabaseProvider> {
  return heldProvider(await openWritable(connection, options, execution, wait, "editor")).provider;
}

/**
 * The provider a tree, monitoring or health read, or a kill, of `connection` runs on (docs/providers/CONTRACT.md,
 * clause C-66): on a connection of session capacity class several (`sessionCapacity` in `./session-capacity`), a
 * metadata session of the connection's own, opened beside the editor's from the same connection, with the same
 * file-access posture and owner, through the same checks in the same order as `getOrCreateProvider`, and cached apart
 * from it under the editor's key with a metadata frame, so it is each owner's own under governance. Its pool holds at
 * most `METADATA_POOL_MAX` sessions and opens none until a read or a kill asks, owned or shared alike. On a connection
 * of class one, the editor's own provider, as `getOrCreateProvider` answers it.
 *
 * The class decides only which session a tree, monitoring or health read, or a kill, runs on and authorizes nothing:
 * every refusal here is `getOrCreateProvider`'s own, raised by the same check. The metadata session takes no catalog: a
 * caller that takes a catalog scopes it (`metadataProvider` and `metadataMonitoringTarget` in
 * src/lib/api/editor-provider.ts). No caller waits for its open with a signal of its own, so it takes no wait. It opens
 * once per key (C-44), leaves with the idle sweep and with every removal that names its connection, its owner or its
 * record's key, is torn down with the caches under the teardown's deadlines (C-45), and keeps the connection's SSH
 * tunnel open while it serves the connection.
 *
 * It answers the provider of a legacy record; `getOrCreateMetadataSession` answers the metadata session of any record,
 * a provider package's among them, and runs this body for a legacy one.
 *
 * @throws UnknownProviderError if the connection's type is absent or names no provider, as `getOrCreateProvider`.
 */
export async function getOrCreateMetadataProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: EditorExecutionContext = {},
): Promise<DatabaseProvider> {
  return heldProvider(await openWritable(connection, options, execution, undefined, "tree")).provider;
}

/**
 * The body of `getOrCreateProvider`, `getOrCreateMetadataProvider` and a legacy record's `getOrCreateEditorSession` and
 * `getOrCreateMetadataSession`: the
 * checks, the session `reads` resolves to, its key, a cached entry's reuse and the open shared per key; it answers the
 * cache's entry. A tree, monitoring or health read, or a kill (`"tree"`, the
 * literal named for the first of them), of a connection whose
 * session capacity class is several takes the metadata session (`METADATA_SESSION`); every other call takes the
 * editor's.
 */
async function openWritable(
  connection: DatabaseConnection,
  options: ProviderOptions,
  execution: EditorExecutionContext,
  wait: OpenWait | undefined,
  reads: "editor" | "tree",
): Promise<CachedSession> {
  // First, ahead of the cache lookup and of any tunnel (#1089): see assertReadOnlyHonoured. The id
  // refusal shares the place: the cache key length-frames connection.id, so a missing id must be
  // refused before the key is computed, as the DatabaseConfigError the provider would have raised (#1539). The type
  // check comes before both: the key frames the type too, and a type that names no provider is refused by name (FND-1).
  const engine = legacyProviderEngine(connection.type, "open");
  assertConnectionIdPresent(connection);
  assertProviderEnabled(engine);
  assertReadOnlyHonoured(engine, connection);
  assertClaimsGranted(engine);
  // Ahead of the cache key, so no cached provider is handed to a record that is not plain data, and of the copy made
  // for the tunnel (assertConnectionIsPlainData in ./provider-connection).
  assertConnectionIsPlainData(connection);
  // Core's decision about the tunnel (./tunnel-decision), ahead of the cache key, which frames the tunnel's route, and
  // of any bastion dial: the tunnel is opened below exactly when this answers `open`.
  const tunnelDecision = decideTunnel(connection, engine);
  assertOwnerPoolHonoured(engine, execution);
  assertEgressDecided();
  // The writable cache never holds a read-only handle, and its key frames no such mode for an
  // execution context: a readOnly reaching the provider from here would be served to every later
  // editor request, or a read-only caller handed the writable one. The type has no such field; a
  // caller that passes one anyway is refused rather than silently given the writable provider.
  // The refusal names the entry point the caller used: `reads` is `"tree"` only from `getOrCreateMetadataProvider`.
  if ((execution as ProviderExecutionContext).readOnly !== undefined) {
    const entryPoint = reads === "tree" ? "getOrCreateMetadataProvider" : "getOrCreateProvider";
    throw new DatabaseConfigError(
      `${entryPoint} takes no readOnly in its execution context: it caches writable providers, so a read-only one would be served to every later request. Build a read-only provider with createDatabaseProvider instead.`,
      connection.type,
    );
  }
  // The DuckDB editor file-access posture, server-derived (non-admin DuckDB file access). A definite boolean, so the
  // handle it opens and the key it is cached under agree, and absent reads as deny (fail closed).
  // SQLite and DuckDB read it; engines without that capability ignore it.
  const allowExternalFileAccess = execution.allowExternalFileAccess === true;
  // The user this provider is opened for under governance (docs/GOVERNANCE.md#per-user-providers), or undefined for the
  // provider every caller shares: the provider, the entry and the key `editorCacheKey` frames all take this value, so
  // they never disagree.
  const owner = providerOwner(connection, execution.owner);
  // Which session serves the call (docs/providers/CONTRACT.md, clause C-66): the host's class, from Studio's records and
  // the connection alone, decides whether a tree, monitoring or health read, or a kill, shares the editor's session.
  const session = reads === "tree" && sessionCapacity(connection) === "several" ? METADATA_SESSION : EDITOR_SESSION;
  const frame = await editorCacheKey(connection, execution);
  const cacheKey = session.key(frame);
  // The metadata session's pool size, shared or owned: the caller's other pool options stand, and the owner's share is
  // replaced, so the key above, which frames the owner and not the size, is unchanged.
  const sized =
    session.poolMax === undefined
      ? { options, execution }
      : {
          options: { ...options, pool: { ...options.pool, min: 0, max: session.poolMax } },
          execution: owner === undefined ? execution : { ...execution, ownerPoolMax: session.poolMax },
        };

  // A saved timeout change must reach the next query, even when the connection is already open (`reusableEntry`).
  const cached = await reusableEntry(session.cache, cacheKey, connection);
  if (cached !== null) return cached;

  // One open per key: a concurrent first caller joins the open in flight rather than building a second provider.
  return sharedOpen(
    session.cache,
    session.flights,
    cacheKey,
    connection,
    {
      connectionId: connection.id,
      owner,
      frame,
      budget: connectBudgetFor(connection.type),
      name: providerName(connection.id, connection.type),
    },
    (flight) =>
      openEditorProvider(
        connection,
        sized.options,
        sized.execution,
        { cache: session.cache, cacheKey, frame, owner, allowExternalFileAccess, tunnelDecision, engine },
        flight,
      ),
    wait,
  );
}

/** What `openWritable` decided before its open, which the open builds with exactly. */
interface EditorOpenPlan {
  /** The cache the open admits into: the writable cache, or the metadata cache for a metadata session. */
  readonly cache: Map<string, CachedSession>;
  readonly cacheKey: string;
  /** The editor's key of the record, the entry's frame. */
  readonly frame: string;
  readonly owner: string | undefined;
  readonly allowExternalFileAccess: boolean;
  readonly tunnelDecision: ReturnType<typeof decideTunnel>;
  /** The engine's record, whose grant of a single-writer file the admission reads. */
  readonly engine: EngineRecord;
}

/**
 * The open `openWritable` shares under `plan.cacheKey`: it closes a stale single-writer handle of the record in
 * `plan.cache`, opens the tunnel, builds and connects the provider, and admits it into `plan.cache` itself, so an open no
 * caller waits for any more is still admitted once. An open a removal or a cache close overtook admits nothing
 * (`connectUnlessOvertaken`). On the metadata cache the stale close finds nothing and no entry records a file, by
 * construction: the session capacity class never opens a metadata session for an engine granted a single-writer file.
 */
async function openEditorProvider(
  connection: DatabaseConnection,
  options: ProviderOptions,
  execution: EditorExecutionContext,
  plan: EditorOpenPlan,
  flight: Flight<OpenMeta>,
): Promise<CachedSession> {
  const { cache, cacheKey, frame, owner, allowExternalFileAccess, tunnelDecision, engine } = plan;
  // A single-writer engine keeps ONE writable handle per file per process. We are about to open one
  // under `cacheKey`, so a handle of THIS connection record on the SAME file under a DIFFERENT key would
  // be a second handle on one file. That happens whenever one record's key changes while its handle is
  // open: an operator edits a DuckDB seed's roles across the admin-only line while Studio runs (the seed
  // file hot-reloads), which flips its file-access posture; an edit changes what the key frames (the
  // fingerprint, the credentials, the read-only mode) and keeps the file; or, on an inline DuckDB
  // connection, an admin and a non-admin present the same client connection id (a browser profile the
  // two accounts share, or a copied id), and then each request closes the other's handle. On DuckDB a
  // second read-write handle keeps its own copy of the catalog and checkpoints it over the file when it
  // closes, losing the first handle's committed rows on Linux and macOS and corrupting the file after a
  // bulk write, and Windows refuses the second open; LibreDB, the other engine granted a single-writer
  // file, refuses it on every platform. So every such stale handle is closed first, as the
  // query-timeout change above closes its own, leaving this open as the file's only handle; the session
  // state on a closed handle (temporary tables, SET values) goes with it. Entries of a DIFFERENT
  // connection id on the same file are the separate, pre-existing D240 case and are left alone here.
  // An entry's `singleWriterFile` is set only for the engines granted a single-writer file, so this is a no-op
  // for the rest without a type-id branch.
  const openFileIdentity = fileIdentity(connection);
  if (openFileIdentity !== null) {
    // Not the key we are about to open under (any entry still there is disconnected, since a connected
    // one would have returned above), and only this record on this file.
    const stale = [...cache].flatMap(([key, { connectionId, opened: held }]) =>
      key !== cacheKey &&
      connectionId === connection.id &&
      held.form === "provider" &&
      held.singleWriterFile === openFileIdentity
        ? [{ key, held }]
        : [],
    );
    // All of them are closed before the open below. A close that fails is logged and its entry dropped
    // all the same, as the query-timeout change above does.
    const closes = await Promise.allSettled(stale.map(({ held }) => held.provider.disconnect()));
    stale.forEach(({ key, held }, index) => {
      const close = closes[index];
      if (close.status === "rejected") {
        // Through the stale entry's own scrub: it was built from the record its own key frames.
        logger.warn(`[DB] Error disconnecting a stale single-writer handle before reopening`, {
          connectionId: connection.id,
          error: String(withholdProviderError(held.scrub, close.reason)),
        });
      }
      cache.delete(key);
    });
  }

  // If SSH tunnel is configured, create tunnel first and rewrite connection.
  // createSSHTunnel hands every caller for the same connection id, bastion route, tunnel credential,
  // pinned host key AND far end the one forward, pooled or still being dialled, so this call reports how its provider fared
  // and the pool decides whether a failure closes the forward (another caller may connect or serve
  // through it).
  const scrub = providerTextScrub(connection, "any");
  let effectiveConnection = connection;
  let tunnel: TunnelInfo | null = null;
  if (tunnelDecision.open) {
    tunnel = await createSSHTunnel(connection.id, tunnelDecision.tunnel, tunnelDecision.host, tunnelDecision.port);
    // Rewrite connection to point to local tunnel endpoint, keeping the far end for the seal
    effectiveConnection = tunnelledConnection(connection, tunnel);
  }

  // Create new provider (async - dynamically loads the provider module). Only the derived posture
  // and owner are handed on, so the handle opens under exactly what its key frames; every provider but
  // DuckDB and SQLite ignores the posture: DuckDB closes file access under a denied posture, and SQLite
  // refuses to open under one. An owner opens the pool of that user's share
  // (docs/GOVERNANCE.md#per-user-providers).
  // The build is inside the try with the connect: a provider constructor that refuses the record comes
  // after the tunnel, and the tunnel is released for that refusal as for a failed connect.
  let entry: CachedSession;
  try {
    const provider = await createDatabaseProvider(effectiveConnection, options, {
      allowExternalFileAccess,
      ...ownerContext(owner, execution),
    });
    // Cache it, remembering the file when this engine admits only one handle on it -
    // that is what lets the callers that would otherwise open a second one find this. Which engines do is the record's
    // `grants.singleWriterFile`, Studio's grant of the claim, never the built provider's own declaration
    // (docs/providers/CONTRACT.md, clause M-57).
    entry = {
      opened: {
        form: "provider",
        provider,
        singleWriterFile: engine.grants.singleWriterFile ? fileIdentity(connection) : null,
        // Recorded so the single-writer borrow lends a DuckDB handle only to a caller of the same
        // posture (non-admin DuckDB file access); ignored for every engine but DuckDB.
        allowExternalFileAccess,
        scrub,
      },
      engine,
      connectionId: connection.id,
      owner,
      frame,
      lastUsed: Date.now(),
      running: 0,
    };
    const admitted = entry;
    const admit = () => {
      if (tunnel) tunnelProviderOpened(tunnel);
      admitted.lastUsed = Date.now();
      cache.set(cacheKey, admitted);
    };
    await connectPhase(() => connectUnlessOvertaken(provider, flight, admit));
  } catch (error) {
    if (tunnel) {
      await releaseTunnelOfUnopenedProvider(tunnel, connection.id, scrub);
    }
    throw error;
  }

  // Start idle sweep if not already running
  startIdleSweep();

  return entry;
}

/**
 * The key `getOrCreateProvider` caches the provider of `connection` under for `execution`: {@link providerCacheKey} of
 * the connection, of its file-access posture as a definite boolean, absent read as deny, and of the owner that
 * `providerOwner` answers. A connection without an id is refused before the key frames it, as in `getOrCreateProvider`
 * (#1539).
 *
 * Exported for two callers that must name a cached entry without deriving a second key, as `profiledCacheKey` is for its
 * own. The transaction route records the key a governed `begin` resolved, and a later request that resolves another
 * one, because the owner's grant level or the connection's credential changed, has the transaction rolled back on the
 * provider {@link findCachedProvider} answers for the recorded key (docs/GOVERNANCE.md#per-user-providers). And without
 * governance the disconnect route removes only the entries the caller's own record names, its editor entry and its
 * execution-profile entries, by the key scope of `removeProvider` (docs/SECURITY.md, note 0.9). The package does not
 * re-export it.
 */
export async function editorCacheKey(
  connection: DatabaseConnection,
  execution: EditorExecutionContext = {},
): Promise<string> {
  assertConnectionIdPresent(connection);
  return providerCacheKey(
    connection,
    execution.allowExternalFileAccess === true,
    providerOwner(connection, execution.owner),
  );
}

/**
 * The provider the writable cache holds under `key`, which {@link editorCacheKey} answers, or null when it holds none
 * there: the idle sweep, a disconnect or a teardown removed it, and disconnected it on the way out. A lookup, not a
 * use: it opens nothing and leaves the entry's idle clock alone. A key under which the cache holds a provider package's
 * session is a host defect, raised by name: no legacy caller computes one. For `cachedEditorProvider` in
 * src/lib/api/editor-provider.ts, on which the transaction route rolls back a transaction whose owner's credential
 * changed (docs/GOVERNANCE.md#per-user-providers); the package does not re-export it.
 */
export function findCachedProvider(key: string): DatabaseProvider | null {
  const entry = providerCache.get(key);
  return entry === undefined ? null : heldProvider(entry).provider;
}

// ============================================================================
// The editor's session of every record, and the one-shot open
// ============================================================================

/**
 * The editor's session of `engine` for `connection`, the cache's entry, for any record the server serves: the cached one
 * when the editor cache holds it, else the open in flight under its key or a new one (docs/providers/CONTRACT.md,
 * clause C-44). With `wait`, the caller stops waiting when `wait.signal` aborts, with its reason, and the open goes on
 * and admits itself.
 *
 * A record that offers a legacy provider opens through `getOrCreateProvider`'s body, whose checks, key and refusals
 * are that entry point's own (its type is read by name first, FND-1), with no provider options. A provider package's
 * record is checked first (`assertOpenable` in ./open-check), keyed by its package's name and the frame `frameCacheKey`
 * answers, and opened through the package's own `open` within the engine's connect budget (`openPackageEntry`).
 *
 * @throws {DatabaseConfigError} Not-sent, for a package's connection with no id or one a check refuses.
 * @throws {StudioTimeoutRefusal} Not-sent, when the engine's connect budget ended the open.
 * @throws {ConnectionError} Not-sent, when a removal or a cache close overtook the open.
 * @throws A legacy provider's error as `getOrCreateProvider` raises it, or the package's error by reference, marked
 *   not-sent.
 */
export async function getOrCreateEditorSession(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  wait?: OpenWait,
): Promise<CachedSession> {
  if (offersLegacyProvider(engine, connection)) return openWritable(connection, {}, execution, wait, "editor");
  return openPackageEntry(connection, engine, execution, wait, PACKAGE_EDITOR_PLACE);
}

/**
 * The connection's metadata session of `engine`, the cache's entry, for any record the server serves
 * (docs/providers/CONTRACT.md, clause C-66): the session its tree reads run on, beside the editor's, so a tree read
 * never waits for the editor's statements.
 *
 * - A record that offers a legacy provider: `getOrCreateMetadataProvider`'s body (`openWritable`), whose checks, key,
 *   pool, entry and refusals are that entry point's own.
 * - A provider package's record whose connection serves one session (`sessionCapacity`, from its register row): the
 *   editor's session, as `getOrCreateEditorSession` answers it.
 * - Every other provider package's record: a session of its own, opened through its package as the editor's is
 *   (`openPackageEntry`), cached in the metadata cache under the editor's key with the metadata frame, its entry's
 *   frame the editor's, so every removal that names the editor's entry names it too, and opened with a pool of at most
 *   `METADATA_POOL_MAX` sessions that opens none until a read asks, shared or owned alike.
 *
 * No caller waits for its open with a signal of its own, so it takes no wait. It opens once per key (C-44), leaves with
 * the idle sweep, which keeps it while a read runs on it (`running`), and with every removal that names its
 * connection, its owner or its record's key, and is torn down with the caches under the teardown's deadlines (C-45).
 *
 * @throws As `getOrCreateEditorSession` throws for the same record.
 */
export async function getOrCreateMetadataSession(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
): Promise<CachedSession> {
  if (offersLegacyProvider(engine, connection)) return openWritable(connection, {}, execution, undefined, "tree");
  if (sessionCapacity(connection) === "one") return getOrCreateEditorSession(connection, engine, execution);
  return openPackageEntry(connection, engine, execution, undefined, PACKAGE_METADATA_PLACE);
}

/** Where a provider package's session is cached and opened: its cache, its opens in flight, its key and its pool. */
interface PackagePlace {
  readonly cache: Map<string, CachedSession>;
  readonly flights: typeof editorFlights;
  /** The key the session caches under, from the package's editor key. */
  readonly key: (editorKey: string) => string;
  /** The pool the open asks for, or undefined for core's defaults and the owner's share. */
  readonly pool: { readonly min: 0; readonly max: number } | undefined;
}

/** The editor's session of a provider package's record. */
const PACKAGE_EDITOR_PLACE: PackagePlace = {
  cache: providerCache,
  flights: editorFlights,
  key: (editorKey) => editorKey,
  pool: undefined,
};

/** The metadata session of a provider package's record, as `METADATA_SESSION` places a legacy provider's. */
const PACKAGE_METADATA_PLACE: PackagePlace = {
  cache: metadataProviderCache,
  flights: metadataFlights,
  key: (editorKey) => withProfile(METADATA_FRAME, editorKey),
  pool: { min: 0, max: METADATA_POOL_MAX },
};

/**
 * The session of a provider package's record that `place` caches, the cache's entry: the cached one, else the open in
 * flight under its key or a new one (`openCachedSession`). The record is checked first (`assertOpenable` in
 * ./open-check) and keyed by its package's name and the frame `frameCacheKey` answers, which is the entry's frame.
 */
async function openPackageEntry(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  wait: OpenWait | undefined,
  place: PackagePlace,
): Promise<CachedSession> {
  if (!connection.id) throw refused("Connection ID is required");
  assertOpenable(engine, connection, execution, "connect");
  const owner = engine.grants.singleWriterFile ? undefined : execution.owner;
  const frame = await frameCacheKey(connection, {
    readsPosture: engine.grants.readsFileAccessPosture,
    allowExternalFileAccess: execution.allowExternalFileAccess === true,
    owner,
  });
  const key = place.key(`package\u0000${servedPackage(engine).name}\u0000${frame}`);
  const cached = place.cache.get(key);
  if (cached !== undefined) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const meta: OpenMeta = {
    connectionId: connection.id,
    owner,
    frame,
    budget: packageConnectBudget(engine),
    name: sessionName(connection.id, engine),
  };
  // The open is handed the posture as the caller gave it, so the open check `openEngine` runs reads what the check
  // above read; `packageOpenContext` hands the package the definite boolean. The derived boolean frames the key alone.
  const opened: EditorExecutionContext = {
    ...(execution.allowExternalFileAccess !== undefined && {
      allowExternalFileAccess: execution.allowExternalFileAccess,
    }),
    ...(owner !== undefined && { owner, ownerPoolMax: execution.ownerPoolMax }),
  };
  return openOnce(
    place.flights,
    key,
    meta,
    (flight) => openCachedSession(connection, engine, opened, flight, place),
    wait,
  );
}

/** A not-sent configuration error with `sentence`: nothing was opened. */
function refused(sentence: string): DatabaseConfigError {
  const error = new DatabaseConfigError(sentence);
  markNotSent(error);
  return error;
}

/**
 * The open `openPackageEntry` shares under `flight.key` for a provider package's record: it opens the session
 * through the one open function within the engine's connect budget, with the flight's signal as the open's stop and
 * `place`'s pool, and admits it into `place`'s cache, unless a removal or a cache close overtook it (`flight.signal`, or a close of the
 * caches still running, `cacheClosesRunning`), in which case it closes what it opened under the teardown's deadlines
 * and fails as overtaken, admitting nothing. A stop of the package's open by the flight's signal fails as overtaken
 * too. Nothing is awaited between the check and the admission. Every failure is marked not-sent (`connectPhase`).
 */
async function openCachedSession(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  flight: Flight<OpenMeta>,
  place: PackagePlace,
): Promise<CachedSession> {
  let admitted: CachedSession | undefined;
  await connectPhase(async () => {
    let opened: OpenedPackageSession;
    try {
      opened = openedSession(
        await openEngine(engine, {
          connection,
          execution,
          purpose: "connect",
          options: {},
          within: { deadline: Date.now() + flight.meta.budget, signal: flight.signal },
          ...(place.pool !== undefined && { pool: place.pool }),
        }),
      );
    } catch (error) {
      if (flight.signal.aborted && error === flight.signal.reason) throw new ConnectionError(OVERTAKEN_OPEN);
      throw error;
    }
    if (!flight.signal.aborted && cacheClosesRunning === 0) {
      admitted = {
        opened: { form: "session", ...opened },
        engine,
        connectionId: connection.id,
        ...(flight.meta.owner !== undefined && { owner: flight.meta.owner }),
        frame: flight.meta.frame,
        lastUsed: Date.now(),
        running: 0,
      };
      place.cache.set(flight.key, admitted);
      return;
    }
    flightsClosing.add(flight);
    await teardownSession(connection.id, opened);
    throw new ConnectionError(OVERTAKEN_OPEN);
  });
  startIdleSweep();
  return admitted as CachedSession;
}

/**
 * Opens `engine` for `connection` once, never cached, for Test Connection: the one open function, which runs the one
 * ordered open check first, with the open's deadline and the signal that stops it, `within`, the test's own. A legacy
 * record answers its provider built with `options` and `execution` and not connected, which the caller connects under
 * its own deadline; a provider package's record answers its connected session, and a session the package answers after
 * the stop is closed by the host core. Every failure is marked not-sent (`buildPhase`), as `createDatabaseProvider`
 * marks a build's: nothing was sent.
 *
 * @throws {DatabaseConfigError} Not-sent, when the open check refuses the connection.
 * @throws A provider constructor's or the package's error by reference, marked not-sent; a stop answers the signal's
 *   reason.
 */
export async function openEngineOnce(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: ProviderExecutionContext,
  within: { readonly deadline: number; readonly signal: AbortSignal },
  options: ProviderOptions,
): Promise<OpenedEngine> {
  return await buildPhase(() => openEngine(engine, { connection, execution, purpose: "connect", options, within }));
}

// ============================================================================
// Execution-profile provider acquisition (#328)
// ============================================================================

/**
 * The execution profiles this factory can vend. Three exist: `agent-read-only` for
 * the paths that send a model-authored statement, `agent-operations` for the curated
 * reading path that sends none, and `agent-handover` for the editor replay of an
 * answer a run already produced. An unknown profile string is refused, never
 * defaulted (fail closed), and what each one means is stated once in
 * `PROFILE_ACQUISITION`.
 */
export type ExecutionProfile = "agent-read-only" | "agent-operations" | "agent-handover";

/**
 * What a profile means at acquisition: the context the provider is opened under,
 * and whether the profile's calls go through `provider.queryReadOnly`.
 *
 * Single source of truth for the profile list, so a new profile cannot be accepted
 * without stating both. The second field is the engine gate, and it is a PROPERTY OF
 * THE PROFILE rather than of the factory: `agent-read-only` sends model-authored
 * statements, so it is served only on an engine Studio's review record lists
 * (the `agentExecution` grant of its engine record, read through `assertStatementsReviewed` before
 * anything is built, which refuses any other engine with `PROFILE_ENGINE_NOT_REVIEWED`), and only where
 * the provider can also bound one (in one of the three
 * forms the `queryReadOnly` docblock in `src/lib/db/types.ts` names: the engine's own read-only
 * handle or transaction, a least-privilege principal the server's own answers prove, or a
 * Studio-enforced request allowlist plus the identity's own authorization), which a provider
 * without `queryReadOnly` is refused for with `PROFILE_UNSUPPORTED_BY_PROVIDER`. The method is
 * required and never enough. The engines of GRANTED_AGENT_EXECUTION_ENGINES implement that: Apache Cassandra, ClickHouse, Couchbase, Db2 LUW, Apache Druid, DuckDB, Elasticsearch, etcd, Firestore, InfluxDB (InfluxQL), InfluxDB 3 (SQL), Apache Kafka, Kubernetes, LibreDB, libSQL, Milvus, Modbus, MongoDB, MQTT, SQL Server, MTConnect, MySQL, Neo4j, NETCONF, OPC UA, OpenSearch, Oracle, Oxia, PostgreSQL, Prometheus, Qdrant, RabbitMQ, Redis, S3-compatible object storage, SNMP, Sparkplug B, SQLite, Trino and Weaviate (`src/lib/db/claim-grants.ts`). `agent-operations` sends no statement
 * at all: it calls the curated reporting methods, and agent mode asks only for the
 * readings Studio grants the engine, its engine record's `grants.agentReadings`, which is the
 * grant's decision and not this gate's. Requiring a read-only STATEMENT path of it would
 * refuse an engine over a capability
 * the profile never uses. `agent-handover` sends a statement too — the one a run
 * already answered with, replayed in the user's editor — so it takes the same gate as
 * `agent-read-only`; it is a separate row because it carries a different BUDGET
 * (`AGENT_HANDOVER_BUDGET`), and a shared row would have made a later change to one
 * path silently move the other.
 *
 * What all three profiles share is what keeps an acquisition apart from the editor: the
 * same `readOnly: true` (on PostgreSQL and SQL Server that still verifies the role or
 * principal at open, under every profile), the same `agentUser` credential resolution, and
 * the same profiled cache, so neither an operations run nor an editor replay is ever handed
 * the editor's writable pool. What they need not share is a proof a provider keys on
 * `sendsStatements`, the flag `executionContextFor` derives from the second field: such a
 * provider (MongoDB) proves its statement boundary at open for `agent-read-only` and
 * `agent-handover`, and opens `agent-operations`, which sends no statement, with neither the
 * proof nor its refusal.
 */
interface ProfileAcquisition {
  readonly context: ProviderExecutionContext;
  /**
   * Refuse the engine unless Studio's review record lists it (`PROFILE_ENGINE_NOT_REVIEWED`, before anything is
   * built), and the provider unless it implements a read-only statement path (`queryReadOnly`,
   * `PROFILE_UNSUPPORTED_BY_PROVIDER`). Also the source of the context's `sendsStatements`.
   */
  readonly requiresReadOnlyStatements: boolean;
}

const PROFILE_ACQUISITION: Record<ExecutionProfile, ProfileAcquisition> = {
  "agent-read-only": { context: { readOnly: true }, requiresReadOnlyStatements: true },
  "agent-operations": { context: { readOnly: true }, requiresReadOnlyStatements: false },
  "agent-handover": { context: { readOnly: true }, requiresReadOnlyStatements: true },
};

const EXECUTION_PROFILES: ReadonlySet<string> = new Set(Object.keys(PROFILE_ACQUISITION));

/**
 * The execution context a provider is opened with under `profile`, for the requester the acquisition serves.
 *
 * `sendsStatements` is derived from the profile's `requiresReadOnlyStatements` rather than declared in a second column,
 * so the proof a provider runs at open and the engine gate below cannot come to disagree: a profile the gate serves
 * without a read-only statement path is one that sends no statement, and a provider that proves its statement
 * boundary at open does not prove it there. `allowExternalFileAccess` is the requester's posture, absent read as
 * denied.
 *
 * An unknown profile is refused here, never defaulted: the table is a plain object, so a name such as `toString`
 * would read an inherited member and answer a context with no `readOnly` in it. This is the acquisition's refusal:
 * `acquireExecutionProfileProvider`, the one caller, calls this ahead of its cache key and has no check of its own.
 * Exported for the tests.
 */
export function executionContextFor(
  profile: ExecutionProfile,
  requester: EditorExecutionContext = {},
): ProviderExecutionContext {
  if (!EXECUTION_PROFILES.has(profile)) {
    throw new StudioProfileRefusal(`Unknown execution profile: ${String(profile)}`, "UNSUPPORTED_PROFILE");
  }
  const acquisition = PROFILE_ACQUISITION[profile];
  return {
    ...acquisition.context,
    sendsStatements: acquisition.requiresReadOnlyStatements,
    allowExternalFileAccess: requester.allowExternalFileAccess === true,
  };
}

/**
 * Resolves the optional least-privilege agent credential from the connection.
 * `agentPassword` is used as written: a seed delivers it as plaintext or a
 * resolved reference, and a value sealed by the server store opens only in
 * that store, for the record and field it was sealed for, so none is opened
 * here. Fail closed on every misconfiguration:
 *
 * - both fields absent → null (the profile runs under the connection's own
 *   credentials, still on a read-only statement path under a declared
 *   boundary: the engine's own read-only session, or on Kubernetes Studio's
 *   request allowlist with the connection token's RBAC);
 * - only one field present → deny, unless the engine's granted
 *   `policy.agentCredentialForm` is a secret-only form, `"token"` or
 *   `"service-account-key"`, and the field is `agentPassword`: that engine
 *   takes the agent's bearer token or service-account key alone, and refuses
 *   an `agentUser` beside it. A half-configured credential must not silently
 *   degrade to the more privileged default. The form is decided by
 *   `assertAgentCredentialForm` once the provider is built and before it
 *   connects; this function only reads what the fields hold;
 * - a password shaped like a storage envelope (`isEnvelopeClaim`) → deny,
 *   without opening it and never as a plaintext fallback;
 * - combined with a connection string → deny: buildPoolConfig ignores
 *   user/password fields when a connection string is present, so the
 *   credential would be silently dropped and the agent would run as the more
 *   privileged embedded user.
 */
function resolveAgentCredential(connection: DatabaseConnection): { user?: string; password?: string } | null {
  const { agentUser, agentPassword } = connection;
  if (agentUser === undefined && agentPassword === undefined) return null;
  if (connection.connectionString) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" configures an agent credential alongside a connection string; the credential cannot be applied, so acquisition is refused`,
      "AGENT_CREDENTIAL_WITH_CONNECTION_STRING",
    );
  }
  if (!agentPassword) return { user: agentUser };
  if (isEnvelopeClaim(agentPassword)) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" configures an agent credential that cannot be resolved`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  return { user: agentUser, password: agentPassword };
}

/**
 * Refuses an agent credential in a form the engine does not take, before the provider connects. The forms are
 * `AgentCredentialForm` in `src/lib/db/types.ts`: null takes `agentUser` and `agentPassword` together, `"token"`
 * and `"service-account-key"` take `agentPassword` alone, `"dedicated-user"` takes both with a user other than the
 * connection's own, and `"none"` takes nothing. The form is the engine's record's `grants.agentCredentialForm`,
 * Studio's grant of the claim (for a legacy engine `legacyEngineGrants` in ./claim-grants), never the built provider's
 * own `agentCredential` (docs/providers/CONTRACT.md, clause M-57). `password` is the agent secret
 * `resolveAgentCredential` resolved, never echoed.
 */
function assertAgentCredentialForm(
  engine: EngineRecord,
  connection: DatabaseConnection,
  password: string | undefined,
): void {
  const { agentUser, agentPassword } = connection;
  const form = engine.grants.agentCredentialForm;
  if (form === "none") {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" configures an agent credential, and this engine takes none: it has no user for the agent to sign in as, so clear the agent user and password`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  const secretOnly = form === "token" || form === "service-account-key";
  if (secretOnly) {
    const secret = form === "token" ? "token" : "service-account key";
    if (agentUser !== undefined) {
      throw new StudioProfileRefusal(
        `Connection "${connection.id}" configures an agent user, and this engine takes the agent's ${secret} alone: clear the agent user`,
        "AGENT_CREDENTIAL_UNRESOLVABLE",
      );
    }
    if (!agentPassword) {
      throw new StudioProfileRefusal(
        `Connection "${connection.id}" configures an incomplete agent credential: this engine takes the agent's ${secret} alone, and it is empty`,
        "AGENT_CREDENTIAL_UNRESOLVABLE",
      );
    }
  } else if (!agentPassword || !agentUser) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" configures an incomplete agent credential (user and password are both required)`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  if (form === "service-account-key" && !isServiceAccountKey(password)) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" configures an agent password that is not a service-account key, and this engine takes only a service-account key, whose access scope Studio requests itself`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  if (form === "dedicated-user" && sameUser(agentUser, connection.user)) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" configures the connection's own user as the agent user, and this engine takes only an agent user of its own: name a dedicated agent user`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
}

/**
 * Refuses an agent user on an engine that refuses a user name (its record's `connection.refused`, for a legacy
 * engine its row of `REFUSED_CONNECTION_FIELDS` in ./connection-fields), which the overlay in
 * `acquireExecutionProfileProvider` therefore never writes into the connection: without this the agent would sign in
 * with its password alone and the agent user would be dropped with no error. It runs after
 * `assertAgentCredentialForm`, whose sentence answers first on an engine that takes the agent's token alone. It names
 * no type id: the declaration is the record's.
 */
function assertAgentUserTaken(
  engine: EngineRecord,
  connection: DatabaseConnection,
  credential: { readonly user?: string },
): void {
  if (credential.user === undefined || !("user" in engine.connection.refused)) return;
  throw new StudioProfileRefusal(
    `Connection "${connection.id}" configures an agent user, and this engine takes no user name: clear the agent user`,
    "AGENT_CREDENTIAL_UNRESOLVABLE",
  );
}

/** A service-account key JSON, the one Google credential whose token Studio mints itself, at the scope it asks for. */
function isServiceAccountKey(secret: string | undefined): boolean {
  try {
    const parsed: unknown = JSON.parse(secret ?? "");
    return typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "service_account";
  } catch {
    return false;
  }
}

/**
 * Whether two user names name one user, compared without case or surrounding space: wider than any one engine's own
 * folding, so a name the engine would fold onto the connection's own user is refused, fail closed.
 */
function sameUser(agentUser: string | undefined, user: string | undefined): boolean {
  return agentUser?.trim().toLowerCase() === user?.trim().toLowerCase();
}

/**
 * Acquire a provider for (connection id, execution profile). Never touches
 * the shared writable cache in either direction: the profiled provider has
 * its own keyed lifecycle, so an agent execution can never be handed the
 * editor's fully-privileged pool, and an editor request can never be handed a
 * read-only one.
 *
 * Whether an engine is refused is the PROFILE's decision, not this function's. Under
 * `agent-read-only` and `agent-handover` an engine Studio's review record does not list is
 * refused by name with `PROFILE_ENGINE_NOT_REVIEWED`, even when its provider implements
 * `queryReadOnly`, and one the record lists whose provider has no read-only statement path is
 * refused with `PROFILE_UNSUPPORTED_BY_PROVIDER` rather than silently served `query()` (fail
 * closed). Under `agent-operations` neither is asked, because that profile sends no statement
 * for a read-only wrapper to bound. See `PROFILE_ACQUISITION` for the whole of that argument.
 *
 * The refusals come in a fixed order, so a connection with several faults is refused with the
 * earliest: the type and record checks at the top, an unknown profile, then the review record,
 * then the agent credential, then the provider's own refusals once it is built.
 *
 * `requester` is the editor posture of the caller this acquisition serves, as
 * `editorExecutionContext` derives it (non-admin DuckDB file access). It reaches the profiled
 * handle and its cache key, as the editor's posture does: SQLite's drivers cannot confine a
 * statement's file access even on a read-only handle, so a denied requester is refused before its
 * provider is built here too, while DuckDB's read-only profile already closes file access whatever
 * the posture. It also decides which open single-writer handle an `agent-operations` acquisition may borrow:
 * one opened under that same posture, so an admin's agent is grounded from the admin's
 * own editor handle as before, and a requester is never lent a handle wider than its own.
 * Absent means deny, like everywhere else on this channel. Its owner (docs/GOVERNANCE.md#per-user-providers) makes the
 * profiled provider that user's own, as in the writable cache, with the pool of `ownerPoolMax`.
 *
 * `wait` is the caller's own wait for the open, as `getOrCreateProvider` takes it (docs/providers/CONTRACT.md, clauses
 * C-44 and C-77): when its signal aborts, this call rejects with its reason, by reference, while the open goes on for
 * every other caller and admits its provider into the profiled cache once. The single-writer borrow opens nothing and
 * takes no wait. Without it the call waits until the open settles, which its engine's connect budget bounds.
 */
export async function acquireExecutionProfileProvider(
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  options: ProviderOptions = {},
  requester: EditorExecutionContext = {},
  wait?: OpenWait,
): Promise<DatabaseProvider> {
  // First, ahead of the profiled cache lookup and of any tunnel (#1089): see assertReadOnlyHonoured.
  // The id refusal shares the place for the same reason: the profiled key frames connection.id (#1539). The type check
  // comes before both, as in getOrCreateProvider (FND-1).
  const engine = legacyProviderEngine(connection.type, "open");
  assertConnectionIdPresent(connection);
  assertProviderEnabled(engine);
  assertReadOnlyHonoured(engine, connection);
  assertClaimsGranted(engine);
  // As in getOrCreateProvider, and ahead of the copy that carries the agent credential, which would hand the build plain
  // data (assertConnectionIsPlainData in ./provider-connection).
  assertConnectionIsPlainData(connection);
  // Core's decision about the tunnel (./tunnel-decision), as in getOrCreateProvider, and ahead of the statement review
  // below, so an engine that takes no tunnel is refused for that first.
  const tunnelDecision = decideTunnel(connection, engine);
  assertOwnerPoolHonoured(engine, requester);
  assertEgressDecided();
  // Refuses an unknown profile ahead of the cache key, which frames the profile.
  const execution = executionContextFor(profile, requester);
  // A profile that sends statements is granted only on an engine Studio's review record lists, whatever the provider
  // implements: read here, ahead of the cache key, the credential, the tunnel and the provider build, so an engine
  // off the record is refused by name with nothing built or dialled.
  if (execution.sendsStatements) assertStatementsReviewed(connection.type);

  // The requester's own provider under governance (docs/GOVERNANCE.md#per-user-providers), as in the writable cache:
  // `profiledCacheKey` frames the same owner, and the provider and its entry take it from here.
  const owner = providerOwner(connection, requester.owner);
  const cacheKey = await profiledCacheKey(connection, profile, requester);
  const cached = await reusableEntry(profiledProviderCache, cacheKey, connection);
  if (cached !== null) return heldProvider(cached).provider;

  const credential = resolveAgentCredential(connection);
  const acquisition = PROFILE_ACQUISITION[profile];

  /*
    The single-writer exception (B49), and why it is safe HERE and nowhere else.

    On an engine granted a single-writer file the file admits one open handle, so
    opening a second one for this acquisition does not produce a less privileged
    handle - it throws, and the run continues silently ungrounded (a `ConnectionError`
    becomes an unavailable capture). Every agent grounding read on a LibreDB
    connection was lost that way from the moment anyone browsed it in the sidebar.

    Two bounds keep the isolation invariant intact. It is scoped to the profile that
    sends NO statement of the model's: `agent-operations` calls the curated reporting
    methods only, so there is nothing here for a read-only statement path to bound,
    and `agent-read-only` / `agent-handover` are never served the writable handle. They
    open their own instead, which on a single-writer engine is a second handle the lock
    refuses unless the engine opens it without one: LibreDB opens a handle that sends
    statements through its read-only file adapter, which takes no lock and cannot write,
    so it opens beside the held writer. And it is refused when the connection
    configures an agent credential, because the borrowed handle was opened under the
    connection's own - a reuse cannot silently substitute one principal for another.

    The provider is returned WITHOUT being cached under the profiled key: it is
    borrowed, and an entry there would let this cache's idle sweep - or a
    `removeProvider` for any connection sharing the file - close the file under the
    session that opened it.
  */
  if (!acquisition.requiresReadOnlyStatements && credential === null) {
    // Posture-aware for DuckDB (non-admin DuckDB file access): only a handle opened under the requester's own editor
    // posture is borrowed, so an admin's agent on a connection only admins use is grounded from
    // the admin's editor handle, and nobody is lent a handle wider than their own. Where none
    // matches it opens its own read-only handle, which is safe beside a writer. The posture is
    // ignored for libredb, the other single-writer engine, so its borrow is unchanged.
    const open = findOpenSingleWriterProvider(connection, requester.allowExternalFileAccess);
    if (open) return open;
  }

  // The editor's key of the record the acquisition serves, the profiled entry's frame: `profiledCacheKey` framed the
  // profile onto the same key, so a removal's key scope names the record's profiled entries by it.
  const frame = await editorCacheKey(connection, requester);

  /*
    The open, shared under the profiled key with every concurrent first acquisition (`sharedOpen`). It overlays the
    agent credential, opens the tunnel, builds the provider, applies the provider's own refusals, connects it and admits
    it into the profiled cache itself, so an open no caller waits for any more is still admitted once. An open a removal
    or a cache close overtook admits nothing (`connectUnlessOvertaken`).
  */
  const openProfiledProvider = async (flight: Flight<OpenMeta>): Promise<CachedSession> => {
    // A partial credential is overlaid as it stands so the provider can be built; one in a form the engine's record
    // does not take is refused below, before any connect. Each half is overlaid only into a field the engine receives
    // (`providerFields`): an agent user on an engine that takes no user stays out of the record the build reads, so
    // core's refusal of a field the engine refuses (`assertOpenable` in ./open-check) never speaks for it, and the
    // agent credential's own refusal below names it.
    const received: readonly string[] = credential ? providerFields(connection.type) : [];
    let effectiveConnection: DatabaseConnection = credential
      ? {
          ...connection,
          ...(credential.user === undefined || !received.includes("user") ? {} : { user: credential.user }),
          ...(credential.password === undefined || !received.includes("password")
            ? {}
            : { password: credential.password }),
        }
      : connection;

    // The SSH tunnel is keyed by connection id, bastion route, tunnel credential, pinned host key and far
    // end, and shared with the writable provider (createSSHTunnel hands every caller for that forward the one forward). This
    // acquisition reports how its provider fared, and the pool decides whether a failure closes it.
    const scrub = providerTextScrub(connection, "profiled");
    let tunnel: TunnelInfo | null = null;
    if (tunnelDecision.open) {
      tunnel = await createSSHTunnel(connection.id, tunnelDecision.tunnel, tunnelDecision.host, tunnelDecision.port);
      effectiveConnection = tunnelledConnection(effectiveConnection, tunnel);
    }

    const releaseTunnel = async () => {
      if (tunnel) await releaseTunnelOfUnopenedProvider(tunnel, connection.id, scrub);
    };

    // A provider constructor that refuses the record comes after the tunnel, so the build releases the
    // tunnel on that refusal as every later step below does on its own.
    let provider: DatabaseProvider;
    try {
      provider = await createDatabaseProvider(effectiveConnection, options, {
        ...execution,
        ...ownerContext(owner, requester),
      });
    } catch (error) {
      await releaseTunnel();
      throw error;
    }
    if (credential !== null) {
      try {
        assertAgentCredentialForm(engine, connection, credential.password);
        assertAgentUserTaken(engine, connection, credential);
      } catch (error) {
        await releaseTunnel();
        throw error;
      }
    }
    if (acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function") {
      await releaseTunnel();
      throw new StudioProfileRefusal(
        `Provider type "${connection.type}" implements no read-only statement path (queryReadOnly)`,
        "PROFILE_UNSUPPORTED_BY_PROVIDER",
      );
    }

    const entry: CachedSession = {
      opened: { form: "provider", provider, scrub },
      engine,
      connectionId: connection.id,
      owner,
      frame,
      lastUsed: Date.now(),
      running: 0,
    };
    const admit = () => {
      if (tunnel) tunnelProviderOpened(tunnel);
      entry.lastUsed = Date.now();
      profiledProviderCache.set(cacheKey, entry);
    };
    try {
      await connectPhase(() => connectUnlessOvertaken(provider, flight, admit));
    } catch (error) {
      await releaseTunnel();
      throw error;
    }
    startIdleSweep();

    return entry;
  };

  // One open per key, as in getOrCreateProvider; the borrow above opens nothing, so it never waits on a flight.
  const entry = await sharedOpen(
    profiledProviderCache,
    profiledFlights,
    cacheKey,
    connection,
    {
      connectionId: connection.id,
      owner,
      frame,
      budget: connectBudgetFor(connection.type),
      name: providerName(connection.id, connection.type),
    },
    openProfiledProvider,
    wait,
  );
  return heldProvider(entry).provider;
}

/**
 * Remove the cached providers and sessions of `connectionId` and close them, from the writable cache, a provider
 * package's sessions among its entries, the execution-profile cache and the metadata cache alike: a deleted or
 * re-credentialed connection must not leave a stale agent pool running under the old configuration. The scope decides which entries of the connection go, and no scope ever reaches another
 * connection's:
 *
 * - Without a scope, every entry of the connection in every cache, and then its SSH tunnel, as before owners existed.
 * - With an owner scope, every entry of any cache opened for `scope.owner`, and no other. Under governance every
 *   user's providers are their own (docs/GOVERNANCE.md#per-user-providers), so one user's disconnect must not tear down
 *   another user's pool, session state or transaction. An engine that keeps one handle per file records no owner on it
 *   (`providerOwner`), so its one handle, which every owner shares, is left to the removal without a scope.
 * - With a key scope, every entry whose frame is `scope.key`, which {@link editorCacheKey} answers for one record of the
 *   connection: the entry the writable cache holds under that key, the entries the profiled cache holds under that key
 *   with a profile framed onto it (`withProfile`), the record's own execution-profile providers, and the entry the
 *   metadata cache holds under that key with the metadata frame, the record's own metadata session
 *   (docs/providers/CONTRACT.md, clause C-66). A provider package's session frames its key the same way
 *   (`frameCacheKey`), so its record's key names it too. No other entry goes: one opened with another record of the same id, or under another file-access posture, is cached under
 *   another key. Without governance every caller of a connection shares its provider, so a disconnect may remove only
 *   what the caller's own record names (docs/SECURITY.md, note 0.9). The key frames the server and the credentials, so
 *   naming a connection id reaches nothing.
 *
 * The SSH tunnel serves every entry of the connection, so a scoped removal closes it only once no entry of any cache
 * still serves the connection, as the idle sweep does. A scope that names neither an owner nor a key as a string, or
 * names both, is refused before anything is removed: matching on a missing owner would remove the entries every caller
 * shares.
 *
 * An owned entry and a provider package's session are torn down (`teardownEntry`): each leaves the cache first, an open
 * transaction on a provider is rolled back, a pool that hangs is abandoned and a session's close is cut at the close
 * deadline, so the removal of a user's providers, which the governance loader asks for when a grant is taken away or
 * changed (`src/lib/db/owner-removal.ts`), ends within 15 s. They are torn down at once, and before the tunnel goes.
 * The legacy providers every caller shares are disconnected at once too, beside them, each leaving its cache once its
 * own disconnect has answered, and all of them before the tunnel goes.
 *
 * An open still in flight that the scope names, by its connection, its owner or its key as the entries are named, is
 * overtaken (docs/providers/CONTRACT.md, clause C-44): once it has connected it closes the provider it built and admits
 * nothing, and its callers are answered a not-sent `ConnectionError` saying the connection was closed while it was
 * opening. A removal states that what it names must not stay open, so an open it overtook is not admitted after it.
 * The removal does not wait for such an open; it closes itself.
 */
export async function removeProvider(
  connectionId: string,
  scope?: { owner: string; key?: never } | { key: string; owner?: never },
): Promise<void> {
  const owner: unknown = scope?.owner;
  const scopedKey: unknown = scope?.key;
  const byKey = typeof scopedKey === "string" && owner === undefined;
  if (scope !== undefined && !byKey && !(typeof owner === "string" && scopedKey === undefined)) {
    throw new DatabaseConfigError(
      "removeProvider takes a scope only with the owner whose providers it removes or the cache key of the record whose providers it removes, as a string, and never with both.",
    );
  }
  // A key scope names every entry and open of the record by its frame, the record's editor key: its writable entry, its
  // profiled entries, its metadata session and a provider package's session alike.
  const removes = (entry: { connectionId: string; owner?: string; frame: string }): boolean =>
    entry.connectionId === connectionId &&
    (scope === undefined || (byKey ? entry.frame === scopedKey : entry.owner === owner));
  const teardowns: Promise<boolean>[] = [];
  const disconnects: Promise<void>[] = [];

  // An open in flight the scope names is overtaken first: it closes what it opens and admits nothing
  // (`connectUnlessOvertaken`), so a removal is never undone by an open that was still connecting when it ran.
  for (const flights of [editorFlights, profiledFlights, metadataFlights]) {
    discardFlights(flights, (flight) => removes(flight.meta), "removeProvider");
  }

  /**
   * Disconnects `held`, the legacy provider of an entry every caller shares, a failed disconnect logged by `noun`
   * through the entry's scrub, and takes the entry out of `cache` once its disconnect has answered. It never rejects.
   */
  const disconnectShared = async (
    cache: Map<string, CachedSession>,
    noun: CacheNoun,
    key: string,
    held: HeldProvider,
  ): Promise<void> => {
    try {
      await held.provider.disconnect();
    } catch (error) {
      logger.warn(`Error disconnecting ${noun} ${sanitize(connectionId)}`, {
        connectionId,
        error: String(withholdProviderError(held.scrub, error)),
      });
    }
    cache.delete(key);
  };

  /**
   * Starts the removal of the entries of `cache` the scope names: an owned entry's or a provider package's session's
   * teardown (`teardownEntry`) and a shared legacy provider's disconnect (`disconnectShared`) are each started beside
   * the others and collected, for the removal to wait for together.
   */
  const removeEntries = (cache: Map<string, CachedSession>, noun: CacheNoun): void => {
    // A connection can hold more than one entry in a cache, one per distinct server-and-credentials it was opened
    // with, so this removes every entry serving it.
    for (const [key, entry] of cache) {
      if (!removes(entry)) continue;
      const held = entry.opened;
      if (held.form === "provider" && entry.owner === undefined) {
        disconnects.push(disconnectShared(cache, noun, key, held));
      } else {
        teardowns.push(teardownEntry(cache, key, entry));
      }
    }
  };
  removeEntries(providerCache, "provider");
  removeEntries(profiledProviderCache, "profiled provider");
  removeEntries(metadataProviderCache, "metadata provider");
  await Promise.all([...teardowns, ...disconnects]);

  // The entries the scope left, another owner's or another record's, keep the tunnel they reach the connection through.
  if (scope !== undefined && connectionStillServed(connectionId)) return;

  // Close SSH tunnel if exists
  try {
    await closeSSHTunnel(connectionId);
  } catch (error) {
    logger.warn(`Error closing SSH tunnel for ${sanitize(connectionId)}`, { connectionId, error: String(error) });
  }
}

// Every copy of this module a process loads registers its owner-scoped removal, because the governance loader runs in
// another Next.js bundle than the route handlers that fill these caches (src/lib/db/owner-removal.ts).
registerOwnerRemoval(removeProvider);

/**
 * Waits for an open a cache close overtook at most the teardown's close deadline, and answers its name when it was
 * still opening at the cut, logged with the state it was in, or null once it settled. An overtaken open closes what it
 * opened itself (`connectUnlessOvertaken`), so one still connecting at the cut closes later, if its connect ever
 * answers, and one that connected and is still closing at the cut is cut by its own close deadline.
 */
async function overtakenOpenStillOpening(overtaken: DiscardedFlight<OpenMeta>): Promise<string | null> {
  if ((await settleWithin(overtaken.settled, TEARDOWN_CLOSE_MS)).state === "done") return null;
  const { connectionId: id, name } = overtaken.flight.meta;
  const opening = `[DB] The open of ${sanitize(id)} was still`;
  const cut = `when the caches closed, after ${TEARDOWN_CLOSE_MS} ms`;
  logger.warn(
    flightsClosing.has(overtaken.flight)
      ? `${opening} closing the provider it opened ${cut}; its close is cut at its own deadline.`
      : `${opening} connecting ${cut}; it closes itself if its connect answers.`,
    { connectionId: id },
  );
  return name;
}

/**
 * Closes every cached provider and session (shared, execution-profile and metadata, a provider package's sessions among
 * the shared cache's entries), all at once, and answers the names (`entryName`) of those that did not close
 * completely: one whose rollback or close failed or was cut, and an open in flight still connecting at the close
 * deadline. Every entry, owned (docs/GOVERNANCE.md#per-user-providers) or shared alike, is torn down by its form
 * (`teardownEntry`): its entry leaves the cache, an open transaction a provider holds is rolled back within 5 s, and it
 * is closed within 10 s, so the close ends within 15 s whatever the databases do (docs/providers/CONTRACT.md, clause
 * C-45). A provider package's session takes no rollback step. A rollback or a disconnect that fails is logged with the error's name and
 * message, through the entry's scrub, the text the scrub reads. Every open in flight, one its own deadline ended that is
 * still connecting included (clause C-55), is overtaken first, so none is admitted after the caches closed, and each is
 * waited for at most the teardown's close deadline (clause C-44). An open
 * that starts while the close runs and settles before it ended is overtaken alike (`cacheClosesRunning`): it closes
 * what it opened and admits nothing, so no provider is left in a cache, or dropped from one without a close, when the
 * close answers.
 */
async function closeCaches(): Promise<string[]> {
  cacheClosesRunning += 1;
  try {
    return await closeEveryProvider();
  } finally {
    cacheClosesRunning -= 1;
  }
}

/**
 * The body of `closeCaches`, which runs it with every open that settles meanwhile overtaken. Each entry leaves its cache
 * when its teardown starts, and no open is admitted until the close ended, so the caches are empty when it answers.
 */
async function closeEveryProvider(): Promise<string[]> {
  // Stop idle sweep
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  const closes: Promise<string | null>[] = [
    ...discardFlights(editorFlights, () => true, "closeCaches"),
    ...discardFlights(profiledFlights, () => true, "closeCaches"),
    ...discardFlights(metadataFlights, () => true, "closeCaches"),
  ].map(overtakenOpenStillOpening);
  /** Answers the entry's name when its close did not complete, so the caller lists it, and null when it did. */
  const notClosed = (entry: CachedSession) => (closed: boolean) => (closed ? null : entryName(entry));

  for (const [key, entry] of providerCache) {
    closes.push(teardownEntry(providerCache, key, entry).then(notClosed(entry)));
  }
  for (const [key, entry] of profiledProviderCache) {
    closes.push(teardownEntry(profiledProviderCache, key, entry, "profiled provider").then(notClosed(entry)));
  }
  for (const [key, entry] of metadataProviderCache) {
    closes.push(teardownEntry(metadataProviderCache, key, entry, "metadata provider").then(notClosed(entry)));
  }

  return (await Promise.all(closes)).filter((id): id is string => id !== null);
}

/**
 * Clear all cached providers and sessions (shared, execution-profile and metadata), all at once (`closeCaches`), within
 * 15 s. An entry whose close fails or is cut is logged, and the clear still resolves.
 * At a shutdown Studio's handler owns, the handler (src/lib/shutdown-handler.ts) closes the caches through the shutdown
 * registry, where each copy of this module registers `closeCachesAtShutdown` below; importing this module adds no
 * process listener, so an embedder of the package that wants its pools closed on a signal calls this from its own
 * handler.
 */
export async function clearProviderCache(): Promise<void> {
  await closeCaches();
}

/**
 * The close each copy of this module registers for the shutdown: `closeCaches`, rejecting with the names of the
 * providers and sessions that did not close completely, a legacy provider as `<connection id> (<author> <Studio
 * version>)` and a provider package's session as `<connection id> (<package> <version>)`, so the shutdown counts them as
 * a failed close and does not exit with 0.
 */
async function closeCachesAtShutdown(): Promise<void> {
  const unclosed = await closeCaches();
  if (unclosed.length > 0) throw new Error(`Providers not closed: ${unclosed.join(", ")}`);
}

// Every copy of this module a process loads registers the close of its own caches, as it registers its owner-scoped
// removal above: the shutdown handler lives in the instrumentation bundle and reaches the route handlers' copies only
// through this registry (src/lib/shutdown.ts).
onProviderCacheClose(closeCachesAtShutdown);

/**
 * The editor cache's statistics: how many entries it holds, a provider package's sessions among them, and the
 * connections they serve.
 */
export function getProviderCacheStats(): { size: number; connections: string[] } {
  return {
    size: providerCache.size,
    // The ids, never the keys: a key is a digest, and this is observability for
    // "which connections are open".
    connections: Array.from(providerCache.values(), (entry) => entry.connectionId),
  };
}

/**
 * Execution-profile cache statistics (observability for the isolation
 * invariant: agent acquisitions must never appear in getProviderCacheStats).
 */
export function getExecutionProfileCacheStats(): { size: number; connections: string[] } {
  return {
    size: profiledProviderCache.size,
    connections: Array.from(profiledProviderCache.values(), (entry) => entry.connectionId),
  };
}
