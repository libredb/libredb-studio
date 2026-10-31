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
 * reaches a user. Read-only whatever a profile asks: the closed request table admits reads only.
 *
 * `queryReadOnly` is the agent's: one read of a closed table of four metadata reads (`agent-statement.ts`), sent
 * through the agent's client (`FirestoreAgentClient`), which holds those requests alone and charges each one to the
 * run's read allowance before it is sent, and answered through a metadata-only projection (`agent-metadata-read.ts`):
 * collection ids, a whole collection's or collection group's document count, and a named document's existence and
 * create and update times, never a document id or path, a field name or a field value. On a handle opened for any
 * agent-mode profile every other surface goes through that client too (`agent-surface.ts`): collections are listed with
 * `__name__` alone and only within a run's allowance, fields are never sampled, the console, the Keys panel and the
 * Source tab are refused, and every reading Firestore does not report answers its reason. MCP read stays closed on this
 * engine.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryCancelledError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
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
  ObjectReadOptions,
  ObjectSourceDocument,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderLabels,
  ProviderExecutionContext,
  ProviderOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { createRunRegistry, type RunRegistry } from "@/lib/db/utils/bounded-limiter";
import { secretForms } from "@/lib/db/utils/server-text";
import type { DatabaseConnection, QueryWarning } from "@/lib/types";
import { createFirestoreAgentClient, type FirestoreAgentClient } from "./agent-client";
import {
  FIRESTORE_METADATA_ONLY,
  firestoreAgentFailure,
  firestoreAgentResult,
  runFirestoreAgentRead,
} from "./agent-metadata-read";
import { readFirestoreAgentStatement } from "./agent-statement";
import {
  agentCountObjects,
  agentDescribeObjects,
  agentListObjects,
  FIRESTORE_AGENT_WITHHELD,
  type FirestoreAgentSurfaceCall,
} from "./agent-surface";
import { validateFirestoreConnection } from "./connection-options";
import { executeStatement } from "./console/execute";
import { DEFAULT_DATABASE_ID, FIRESTORE_TYPE, LIMITS } from "./constants";
import { type EmulatorAddress, emulatorAddressOf, type FirestoreAuth, resolveFirestoreAuth } from "./credential-policy";
import { databaseResourceRefusal, ERROR_SENTENCES, googleErrorOf } from "./errors";
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
  profileRequired: "Read-only execution requires a provider opened under the agent read-only profile",
  noEstimate: "Firestore composes no estimating plan for the agent",
  noAllowance:
    "Firestore bills every read, so an agent read needs the run's read allowance, and this one carries none: nothing was sent",
});

const S = FIRESTORE_PROVIDER_SENTENCES;

const EDITIONS: Readonly<Record<string, string>> = { STANDARD: "Standard", ENTERPRISE: "Enterprise" };

/** One connected session: the client, what every request's context carries, its lifetime, and what the probe found. */
interface FirestoreSession {
  readonly client: FirestoreClient;
  /** The agent's client over the same Firestore client: the agent's reads alone, each charged before it is sent. */
  readonly agentClient: FirestoreAgentClient;
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
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    seams: Partial<FirestoreSeams> = {},
  ) {
    super(config, options);
    this.seams = resolveSeams(seams);
    this.emulator = emulatorAddressOf(this.seams.env);
  }

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `queryReadOnly` answer; the operations profile's acquisitions send no statement.
   */
  private get readOnlyProfile(): boolean {
    return this.execution.readOnly === true && this.execution.sendsStatements === true;
  }

  /**
   * Whether this handle was opened for any agent-mode profile: every execution profile opens `readOnly` and no editor
   * handle does. On such a handle every surface reads through the agent's client; the editor's own handles keep every
   * read.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  /**
   * One agent-mode surface over the agent's client, whose failure is worded by its category alone; Studio's own
   * refusals pass as they are.
   */
  private async agentRead<T>(
    options: ObjectReadOptions | undefined,
    work: (client: FirestoreAgentClient, call: FirestoreAgentSurfaceCall) => Promise<T>,
  ): Promise<T> {
    const session = this.requireSession();
    const call: FirestoreAgentSurfaceCall = {
      signal: session.lifetime.signal,
      base: session.base,
      allowance: options?.readAllowance,
    };
    try {
      return await work(session.agentClient, call);
    } catch (error) {
      throw firestoreAgentFailure(error, { statementTimeoutMs: this.queryTimeout }, undefined, false) ?? error;
    }
  }

  /** The refusal of a surface an agent-mode handle does not read, after the connection check every surface makes. */
  private agentWithheld(sentence: string): never {
    this.ensureConnected();
    throw new QueryError(sentence, FIRESTORE_TYPE);
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
      // Document ids, paths, field names and field values are stored values: an agent read answers names, counts and
      // flags.
      metadataOnly: FIRESTORE_METADATA_ONLY,
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
      throw this.probeFailure(error);
    }
    this.session = { client, agentClient: createFirestoreAgentClient(client), base, lifetime, ...probed };
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    if (session !== null) closeSession(session);
  }

  /**
   * A probe's failure: on an agent-mode handle a Google refusal is worded by its category alone, since Google's words
   * are not passed on to agent mode; Studio's own sentences, and every failure on an editor handle, pass as they are.
   */
  private probeFailure(error: unknown): unknown {
    if (!this.agentProfile || googleErrorOf(error) === undefined) return error;
    return firestoreAgentFailure(error, { statementTimeoutMs: this.queryTimeout }, undefined, false) as QueryError;
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
    // The console reads documents, whose ids, fields and values are stored values: never on an agent handle.
    if (this.agentProfile) throw new RefusedBeforeSendError(FIRESTORE_AGENT_WITHHELD.query, FIRESTORE_TYPE, text);
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

  /**
   * One agent statement. Only on a handle opened under the agent read-only profile, and only with the run's read
   * allowance; the statement is read by `readFirestoreAgentStatement` and refused before anything is sent when it is
   * not one read of the closed table. Then the read runs over the agent's client, each request charged to the allowance
   * before it is sent, under the request's time budget and the session's lifetime, with nothing kept from one call for
   * the next, and its answer is the metadata-only projection, refused past the row or byte budget rather than cut. A
   * failure is worded by its category, never by Google's words.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    const session = this.requireSession();
    if (!this.readOnlyProfile) throw new RefusedBeforeSendError(S.profileRequired, FIRESTORE_TYPE, statement);
    assertReadOnlyBudget(budget, FIRESTORE_TYPE);
    if (mode !== "execute") throw new RefusedBeforeSendError(S.noEstimate, FIRESTORE_TYPE, statement);
    const allowance = budget.readAllowance;
    if (allowance === undefined) throw new RefusedBeforeSendError(S.noAllowance, FIRESTORE_TYPE, statement);
    const reading = readFirestoreAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, FIRESTORE_TYPE, statement);
    const deadline = this.seams.timeoutSignal(budget.statementTimeoutMs);
    const signal = AbortSignal.any([session.lifetime.signal, deadline]);
    const started = this.seams.now();
    try {
      const answer = await runFirestoreAgentRead(session.agentClient, reading.plan, {
        budget,
        call: { signal, base: session.base, allowance },
      });
      return firestoreAgentResult(answer, budget, this.seams.now() - started);
    } catch (error) {
      throw firestoreAgentFailure(error, budget, statement, deadline.aborted) ?? error;
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

  public async countObjects(
    container: readonly string[],
    options?: ObjectReadOptions,
  ): Promise<Record<string, KindCount>> {
    if (this.agentProfile) return this.agentRead(options, (client, call) => agentCountObjects(client, container, call));
    return this.read((client, signal, base) => countFirestoreObjects(client, container, signal, base));
  }

  public async listObjects(
    container: readonly string[],
    kind: string,
    options?: ObjectReadOptions,
  ): Promise<DatabaseObject[]> {
    if (this.agentProfile)
      return this.agentRead(options, (client, call) => agentListObjects(client, container, kind, call));
    return this.read((client, signal, base) => listFirestoreObjects(client, container, kind, signal, base));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    // A field expand samples documents, whose field names and values are stored values.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.fields);
    return this.read((client, signal, base) => describeFirestoreObject(client, path, kind, signal, base));
  }

  public async describeObjects(
    container: readonly string[],
    kind: string,
    limit?: number,
    options?: ObjectReadOptions,
  ): Promise<ObjectDetailBatch> {
    if (this.agentProfile)
      return this.agentRead(options, (client, call) => agentDescribeObjects(client, container, kind, limit, call));
    return this.read((client, signal, base) => describeFirestoreObjects(client, container, kind, limit, signal, base));
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.source);
    return this.read((client, signal, base) => readFirestoreSource(client, path, kind, limit, signal, base));
  }

  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.keys);
    return this.read((client, signal, base) => scanFirestoreLevel(options, client, signal, base));
  }

  // ==========================================================================
  // Health and monitoring: no request, because every read is billed
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.requireSession();
    // On an agent-mode handle the size Firestore does not report is its reason, not a reading.
    const databaseSize = this.agentProfile ? FIRESTORE_AGENT_WITHHELD.databaseSize : "N/A";
    return { databaseSize, cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
  }

  /** What the connect probe found; nothing is read for it. */
  public async getOverview(): Promise<DatabaseOverview> {
    // On an agent-mode handle the zeros below would read as the server's own figures; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.overview);
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
    // On an agent-mode handle an empty answer would read as the server's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.performance);
    this.ensureConnected();
    return {};
  }

  /** Firestore keeps no query log Studio reads. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    // On an agent-mode handle an empty answer would read as the server's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.slowQueries);
    this.ensureConnected();
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    // On an agent-mode handle an empty answer would read as the server's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.sessions);
    this.ensureConnected();
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    // On an agent-mode handle an empty answer would read as the server's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.tableStats);
    this.ensureConnected();
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    // On an agent-mode handle an empty answer would read as the server's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.indexStats);
    this.ensureConnected();
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    // On an agent-mode handle an empty answer would read as the server's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(FIRESTORE_AGENT_WITHHELD.storage);
    this.ensureConnected();
    return [];
  }

  /** `supportsMaintenance: false`: nothing sends maintenance, and a direct call is refused. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(S.maintenance, FIRESTORE_TYPE);
  }
}
