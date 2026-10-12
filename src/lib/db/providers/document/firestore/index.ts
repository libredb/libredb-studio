/**
 * Firestore provider: a read-only explorer of one Cloud Firestore database in Native mode over the REST v1 API. Top-
 * level collections in the tree, documents and subcollections at any depth in the Keys panel, a document's data in
 * the Source tab, and a parsed subset of the Admin SDK query chain in the console, which Studio compiles to one REST
 * request and never runs as JavaScript.
 *
 * COMPOSITION AND DELEGATION ONLY. The connection rules are `connection-options.ts`, the credential and emulator
 * policy `credential-policy.ts`, the requests `requests.ts` behind `transport.ts`, the console `console/`, the tree
 * and the Source tab `objects.ts`, the Keys panel `key-scan.ts`, every failure sentence `errors.ts`. What stays here is
 * the session's lifecycle, the declarations, the connect probe and the members that answer with no request.
 *
 * The constructor opens nothing; it reads only whether this server sends Firestore to the emulator, because that
 * decides whether Explain is declared. Connect probes the database resource (database metadata, no document read),
 * or one collection id page on the emulator, which serves no database resource. The transport bounds every request
 * by the connection's query timeout plus 5 seconds; this class hands it the timeout. A statement runs under the run
 * registry, so `cancelQuery` aborts it by its id and the run answers the cancel. Each session keeps the credential's
 * kind and secret forms, which every request's error context carries, so no Google message quoting the credential
 * reaches a user. Read-only whatever a profile asks: the closed request table admits reads only. No `queryReadOnly`,
 * so no agent statement execution and no MCP read.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryCancelledError, QueryError } from "@/lib/db/errors";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KeyScanOptions,
  KeyScanPage,
  KindCount,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectSourceDocument,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { createRunRegistry, type RunRegistry } from "@/lib/db/utils/bounded-limiter";
import { secretForms } from "@/lib/db/utils/server-text";
import type { DatabaseConnection, QueryWarning } from "@/lib/types";
import { validateFirestoreConnection } from "./connection-options";
import { executeStatement } from "./console/execute";
import { DEFAULT_DATABASE_ID, FIRESTORE_TYPE, LIMITS } from "./constants";
import { type EmulatorAddress, emulatorAddressOf, type FirestoreAuth, resolveFirestoreAuth } from "./credential-policy";
import { databaseResourceRefusal, ERROR_SENTENCES } from "./errors";
import { FIRESTORE_KEY_SCAN, scanFirestoreLevel } from "./key-scan";
import { FIRESTORE_LABELS } from "./labels";
import type { FirestoreTarget } from "./names";
import {
  type CallBase,
  callContext,
  countFirestoreObjects,
  describeFirestoreObject,
  describeFirestoreObjects,
  FIRESTORE_OBJECT_KINDS,
  isRecord,
  listFirestoreObjects,
  readFirestoreSource,
} from "./objects";
import { type FirestoreSeams, resolveSeams } from "./seams";
import { createFirestoreClient, type FirestoreClient } from "./transport";

export const FIRESTORE_PROVIDER_SENTENCES = Object.freeze({
  emulator: (display: string): string =>
    `Connected to the Firestore emulator at ${display}, not to Google; FIRESTORE_EMULATOR_HOST is set on this server`,
  emptyEmulator:
    "The emulator listed no collection: it creates any project and database on demand, so the project id must match the one the data was written under",
  pastedToken:
    "A pasted access token lasts about an hour and Studio never refreshes it: paste a new one when Firestore refuses it, or use a service-account key",
  parameters: "Firestore statements take no parameters: write the values in the statement.",
  maintenance: "Firestore has no maintenance operation, and Studio only reads it.",
});

const S = FIRESTORE_PROVIDER_SENTENCES;

const EDITIONS: Readonly<Record<string, string>> = { STANDARD: "Standard", ENTERPRISE: "Enterprise" };

/** One connected session: the client, what every request's context carries, its lifetime, and what the probe found. */
interface FirestoreSession {
  readonly client: FirestoreClient;
  readonly base: CallBase;
  /** Aborted at disconnect, so no request outlives its session. */
  readonly lifetime: AbortController;
  readonly warnings: readonly QueryWarning[];
  readonly version: string;
}

interface Probed {
  readonly warnings: readonly QueryWarning[];
  readonly version: string;
}

/** The credential's kind and the forms of every secret it holds, for the error context of each request (S7). */
export function sessionBase(auth: FirestoreAuth): CallBase {
  if (auth.mode === "emulator") return { credential: "emulator", secretForms: [] };
  const credentials = auth.credentials;
  const secrets =
    credentials.type === "access_token"
      ? [credentials.token]
      : credentials.type === "service_account"
        ? [credentials.privateKey, ...(credentials.privateKeyId === undefined ? [] : [credentials.privateKeyId])]
        : credentials.type === "authorized_user"
          ? [credentials.clientSecret, credentials.refreshToken]
          : [];
  return { credential: credentials.type, secretForms: secretForms(secrets) };
}

function closeSession(session: Pick<FirestoreSession, "client" | "lifetime">): void {
  session.lifetime.abort();
  session.client.close();
}

/** The database resource: proves the credential and the database; errors.ts names the mode and access refusals. */
async function probeGoogle(
  client: FirestoreClient,
  base: CallBase,
  pastedToken: boolean,
  signal: AbortSignal,
): Promise<Probed> {
  const answer = await client.send({ kind: "database" }, { signal, context: callContext(client, base, "connect") });
  const refusal = databaseResourceRefusal(answer);
  if (refusal !== null) throw refusal;
  // databaseResourceRefusal refuses every answer that is not an object.
  const edition = EDITIONS[String((answer as Readonly<Record<string, unknown>>).databaseEdition)] as string | undefined;
  return {
    version: edition === undefined ? "Cloud Firestore" : `Cloud Firestore, ${edition} edition`,
    warnings: pastedToken ? [{ message: S.pastedToken }] : [],
  };
}

/** One collection id page: the emulator serves no database resource. */
async function probeEmulator(
  client: FirestoreClient,
  base: CallBase,
  emulator: EmulatorAddress,
  signal: AbortSignal,
): Promise<Probed> {
  const answer = await client.send(
    { kind: "listCollectionIds", parent: [], pageSize: 1 },
    { signal, context: callContext(client, base, "connect") },
  );
  if (!isRecord(answer)) throw new DatabaseConfigError(`${ERROR_SENTENCES.probeUnreadable}.`, FIRESTORE_TYPE);
  const listed = Array.isArray(answer.collectionIds) && answer.collectionIds.length > 0;
  return {
    version: `Firestore emulator at ${emulator.display}`,
    warnings: [{ message: S.emulator(emulator.display) }, ...(listed ? [] : [{ message: S.emptyEmulator }])],
  };
}

function probe(client: FirestoreClient, base: CallBase, auth: FirestoreAuth, signal: AbortSignal): Promise<Probed> {
  return auth.mode === "emulator"
    ? probeEmulator(client, base, auth.emulator, signal)
    : probeGoogle(client, base, auth.credentials.type === "access_token", signal);
}

export class FirestoreProvider extends BaseDatabaseProvider {
  private session: FirestoreSession | null = null;
  private readonly seams: FirestoreSeams;
  /** Read once: the emulator switch is per server and needs a restart to change. */
  private readonly emulator: EmulatorAddress | null;
  private readonly runs: RunRegistry = createRunRegistry();

  /**
   * Opens nothing, so a provider built only for its declarations (the factory's census, `POST /api/db/provider-meta`)
   * touches no socket. A malformed `FIRESTORE_EMULATOR_HOST` is refused here. The seams are the tests'; the factory
   * never passes them, and no connection field reaches them.
   */
  constructor(config: DatabaseConnection, options: ProviderOptions = {}, seams: Partial<FirestoreSeams> = {}) {
    super(config, options);
    this.seams = resolveSeams(seams);
    this.emulator = emulatorAddressOf(this.seams.env);
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    // The emulator ignores Query Explain, so an emulator server draws no Explain button.
    const explain: Pick<ProviderCapabilities, "supportsExplain" | "explainFormat"> =
      this.emulator === null
        ? { supportsExplain: true, explainFormat: "firestore-explain" }
        : { supportsExplain: false };
    return {
      // One query-chain statement per run: "json" means only "not SQL".
      queryLanguage: "json",
      queryDialect: "firestore",
      ...explain,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // `prepareQuery` never pages: the statement carries its own limit, and Studio never pages with `offset`.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      containerLevels: [],
      objectKinds: FIRESTORE_OBJECT_KINDS,
      keyScan: FIRESTORE_KEY_SCAN,
      // No statement changes the tree, so no run re-reads it, which would bill a listing.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...FIRESTORE_LABELS };
  }

  /** The statement carries its own bound: nothing is added, and there is no page two, whatever the options ask. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: LIMITS.defaultQueryLimit, offset: 0 };
  }

  public override validate(): void {
    super.validate();
    const refusals = validateFirestoreConnection(this.config);
    if (refusals.length > 0) throw new DatabaseConfigError(refusals.join(" "), FIRESTORE_TYPE);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** The rules, the credential policy, the client and the probe; a session is kept only after its probe answered. */
  public async connect(): Promise<void> {
    await this.disconnect();
    this.validate();
    const auth = resolveFirestoreAuth(this.config, this.seams);
    const base = sessionBase(auth);
    const client = createFirestoreClient(this.target(), auth, this.seams, { queryTimeoutMs: this.queryTimeout });
    const lifetime = new AbortController();
    let probed: Probed;
    try {
      probed = await probe(client, base, auth, lifetime.signal);
    } catch (error) {
      closeSession({ client, lifetime });
      throw error;
    }
    this.session = { client, base, lifetime, ...probed };
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    if (session !== null) closeSession(session);
  }

  /** The warnings the last `connect()` found, for Test Connection; [] with no session. */
  public connectWarnings(): QueryWarning[] {
    return this.session === null ? [] : [...this.session.warnings];
  }

  private target(): FirestoreTarget {
    // validate() guarantees the project id.
    return { projectId: this.config.database as string, databaseId: this.config.schema || DEFAULT_DATABASE_ID };
  }

  private requireSession(): FirestoreSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as FirestoreSession;
  }

  /** A surface read on the session's client, ended by a disconnect. */
  private read<T>(work: (client: FirestoreClient, signal: AbortSignal, base: CallBase) => Promise<T>): Promise<T> {
    const session = this.requireSession();
    return work(session.client, session.lifetime.signal, session.base);
  }

  // ==========================================================================
  // Query path
  // ==========================================================================

  /**
   * One console statement, re-parsed and compiled on the server by `console/execute.ts`, under the run registry: a
   * cancel aborts its request and the run answers the registry's cancel, whatever the aborted request raised.
   */
  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(S.parameters, FIRESTORE_TYPE);
    const session = this.requireSession();
    const run = this.runs.begin(queryId, session.lifetime.signal);
    try {
      // `...base` gives ExecuteDeps its credential and its secret forms (contract change 3).
      return await executeStatement(text, {
        client: session.client,
        signal: run.signal,
        now: () => this.seams.now(),
        ...session.base,
      });
    } catch (error) {
      if (run.signal.aborted && run.signal.reason instanceof QueryCancelledError) throw run.signal.reason;
      throw error;
    } finally {
      run.end();
    }
  }

  /** Stops a running statement by its id and answers true; an id that names no run answers false. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface and Keys panel, answered by objects.ts and key-scan.ts
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return this.read((client, signal, base) => countFirestoreObjects(client, container, signal, base));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return this.read((client, signal, base) => listFirestoreObjects(client, container, kind, signal, base));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return this.read((client, signal, base) => describeFirestoreObject(client, path, kind, signal, base));
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    return this.read((client, signal, base) => describeFirestoreObjects(client, container, kind, limit, signal, base));
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return this.read((client, signal, base) => readFirestoreSource(client, path, kind, limit, signal, base));
  }

  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    return this.read((client, signal, base) => scanFirestoreLevel(options, client, signal, base));
  }

  // ==========================================================================
  // Health and monitoring: no request, because every read is billed
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.requireSession();
    return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
  }

  /** What the connect probe found; nothing is read for it. */
  public async getOverview(): Promise<DatabaseOverview> {
    const session = this.requireSession();
    return {
      version: session.version,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 0,
      indexCount: 0,
    };
  }

  /** Nothing is measured, so every optional figure is absent. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Firestore keeps no query log Studio reads. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  /** `supportsMaintenance: false`: nothing sends maintenance, and a direct call is refused. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(S.maintenance, FIRESTORE_TYPE);
  }
}
