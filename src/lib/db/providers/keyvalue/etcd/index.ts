/**
 * etcd provider (#1089). Read-write key-value browsing over etcd's gRPC API: prefix groups, members,
 * leases, users and roles in the tree, every key in the Keys panel, a subset of etcdctl's command line in
 * the editor, a key's value edited through a guarded transaction, and compaction, defragmentation and
 * alarm disarm for an admin.
 *
 * COMPOSITION AND DELEGATION ONLY (spec 3.1, 3.5). The wire lives in `grpc-client.ts`, the connection
 * rules in `connection-options.ts`, the grammar in `lexer.ts` and `commands.ts`, a command's run in
 * `execute.ts`, the object surface in `objects.ts`, the Keys panel in `key-scan.ts`, the value edit in
 * `edit.ts`, the monitoring reads in `monitoring-reads.ts`, maintenance in `maintenance.ts`, the grants'
 * unions in `permissions.ts`, result shaping in `results.ts` and the error table in `errors.ts`. What stays
 * here is lifecycle, the declarations, the connect sequence of spec 6.1 with the reads of 4.7, which read each
 * surface makes, and each call's AbortSignal and error context.
 *
 * `cancelQuery` exists because a read or a watch can be stopped (spec 5.5), and it answers false for a
 * write already sent. No `getPoolStats`, no `queryReadOnly` (spec E12) and no transaction methods: each is
 * detected by presence, and none would do its job here.
 */
import { randomUUID } from "node:crypto";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { DatabaseConfigError, DatabaseError, QueryError } from "@/lib/db/errors";
import { findKind, kindHasColumns } from "@/lib/db/object-kinds";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseConnection,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KeyScanOptions,
  KeyScanPage,
  KindCount,
  MaintenanceOperation,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectEditBuild,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditRequest,
  ObjectSourceDocument,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { type EtcdAuthStatus, type EtcdClient, type EtcdClientFactory, EtcdError, type EtcdPermission } from "./client";
import { type EtcdParseLimits, parseEtcdCommand } from "./commands";
import {
  buildEtcdConnectionOptions,
  ETCD_DEFAULT_PORT,
  type EtcdConnectionOptions,
  etcdErrorConnection,
} from "./connection-options";
import { applyEtcdValueEdit, buildEtcdValueEdit, refuseValueEditBeforeRead } from "./edit";
import {
  connectStepError,
  type EtcdConnectStep,
  type EtcdErrorConnection,
  type EtcdErrorContext,
  isUserNameEmpty,
  toProviderError,
} from "./errors";
import { ETCD_READ_BOUNDS, executeCommand } from "./execute";
import { createGrpcEtcdClient } from "./grpc-client";
import { ETCD_KEY_SCAN, readKeyScanOptions, scanEtcdKeysPage } from "./key-scan";
import { ETCD_LABELS } from "./labels";
import { ETCD_SCHEMA_REFRESH_PATTERN } from "./lexer";
import { ETCD_MAINTENANCE_OPERATIONS, ETCD_MAINTENANCE_SPECS, runEtcdMaintenance } from "./maintenance";
import { readEtcdHealth, readEtcdOverview, readEtcdStorageStats, readEtcdTableStats } from "./monitoring-reads";
import {
  countEtcdObjects,
  describeEtcdObject,
  describeEtcdObjects,
  ETCD_OBJECT_KINDS,
  type EtcdSurfaceContext,
  keyOfSourcePath,
  listEtcdObjects,
  readEtcdObjectSource,
} from "./objects";
import { type AccessScope, describeScope, ROOT_ROLE, readableScope, writableScope } from "./permissions";
import { commandResult } from "./results";

const BOUND_PARAMS_MESSAGE = "Bound params are not supported: an etcdctl command has no placeholders";

/**
 * The kind that groups keys (spec 4.1): the one the grants scope, whose names end in `*`, and whose listing is
 * the one listing that walks keys (spec 4.7).
 */
const GROUP_KIND = "prefix";

/**
 * One key (spec 4.1): its source is the one source that reads a key (spec 4.7), and it is listed by the Keys
 * panel alone, so its listing walks nothing and is refused by name with no request (spec 4.3).
 */
const KEY_KIND = "key";

/** What this connection may read and write (spec 4.7), or the refusal met reading its grants. */
type EtcdGrants =
  | { readonly state: "read"; readonly readable: AccessScope; readonly writable: AccessScope }
  | { readonly state: "refused"; readonly refusal: Error };

/**
 * Root, or authentication off: every key, and no grant that scopes a surface. Told apart by identity: the
 * grants of a user who is not root and may read every key are another object, and they scope it (spec 4.7).
 */
const EVERY_KEY: EtcdGrants = { state: "read", readable: { kind: "all" }, writable: { kind: "all" } };

/** The scope of a surface whose grants could not be read: no range, so nothing is read outside a grant. */
const NO_KEY: AccessScope = { kind: "ranges", ranges: [] };

/** The one channel of a connected provider and what it learned while connecting (spec E16). */
interface EtcdSession {
  readonly client: EtcdClient;
  readonly options: EtcdConnectionOptions;
  readonly errors: EtcdErrorConnection;
  /** The etcd user the grants belong to; absent where authentication was off at connect. */
  readonly user?: string;
  grants: EtcdGrants;
  /**
   * The AuthStatus answer the grants were taken under (spec 4.7): whether authentication was on, and the auth
   * store's revision. Every session holds one, on an etcd below 3.7 too, which with authentication on answers
   * AuthStatus and Status to the root role alone, whatever the credential: a session there signs in as root, and
   * a user who is not root is refused at connect. With authentication off it answers both to every caller.
   */
  authStatus: EtcdAuthStatus;
}

/** A query in flight under the caller's id, so cancelQuery reaches it (spec 5.5). */
interface RunningQuery {
  readonly controller: AbortController;
  writeSent: boolean;
}

/** One surface call's client, the grants it runs under, and its context (spec 3.5). */
interface SurfaceCall {
  readonly client: EtcdClient;
  readonly grants: EtcdGrants;
  readonly context: EtcdSurfaceContext;
}

/** A connection is one key space with no container level (spec 4.1), so every object is addressed at the root. */
function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) {
    throw new QueryError(`An etcd connection has no container level; received ${JSON.stringify(container)}`, "etcd");
  }
}

/** A surface that reads keys meets the refusal its grants met (spec 4.7), never an empty answer. */
function requireKeysReadable(grants: EtcdGrants): void {
  if (grants.state === "refused") throw grants.refusal;
}

/** A group row is named `<prefix>*` (keys.ts `groupLabel`), so its prefix is its name without the `*`. */
function groupPrefix(group: DatabaseObject): string {
  return group.name.slice(0, -1);
}

/** "host:port" of the configured endpoint (C4's `endpoint`), an IPv6 literal in brackets, for endpoint status and health. */
function endpointText(endpoint: { readonly host: string; readonly port: number }): string {
  return `${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
}

/** A connect step's refusal: an etcd answer is worded by errors.ts, a defect surfaces as itself. */
function stepError(step: EtcdConnectStep, error: unknown, context: EtcdErrorContext, commonName?: string): Error {
  return error instanceof EtcdError
    ? connectStepError(step, error, context, commonName)
    : toProviderError(error, context);
}

/** The error context of every call that reads `user`'s grants, AuthStatus's revision among them (spec 4.7). */
function grantsContext(user: string, errors: EtcdErrorConnection): EtcdErrorContext {
  return { command: `read of etcd user ${user}'s grants`, write: false, connection: errors };
}

/**
 * The grants of spec 4.7 for `user`: every key for a user holding the root role, else the READ and READWRITE
 * permissions of its roles as the readable union and the WRITE and READWRITE ones as the writable union.
 * `roles` is step 4's answer where the connect sequence already read it. A refusal is kept for the surfaces
 * to name; any other failure is raised.
 */
async function readGrants(
  client: EtcdClient,
  user: string,
  roles: readonly string[] | undefined,
  errors: EtcdErrorConnection,
  signal: () => AbortSignal,
): Promise<EtcdGrants> {
  const context = grantsContext(user, errors);
  try {
    const held = roles ?? (await client.userGet(user, { signal: signal() }));
    if (held.includes(ROOT_ROLE)) return EVERY_KEY;
    // Sent in the order UserGet names the roles, all at once; etcd answers each for a role the caller holds.
    const perRole = await Promise.all(held.map((role) => client.roleGet(role, { signal: signal() })));
    const permissions: readonly EtcdPermission[] = perRole.flat();
    return { state: "read", readable: readableScope(permissions), writable: writableScope(permissions) };
  } catch (error) {
    const mapped = toProviderError(error, context);
    if (error instanceof EtcdError && error.category === "permission-denied")
      return { state: "refused", refusal: mapped };
    throw mapped;
  }
}

/**
 * AuthStatus as it answers now (spec 4.7), whether authentication is on and the auth store's revision, a
 * failure raised as the read of the grants.
 */
async function readAuthStatus(
  client: EtcdClient,
  user: string,
  errors: EtcdErrorConnection,
  signal: AbortSignal,
): Promise<EtcdAuthStatus> {
  try {
    return await client.authStatus({ signal });
  } catch (error) {
    throw toProviderError(error, grantsContext(user, errors));
  }
}

/**
 * A read of the grants that failed, kept for the one count that met it as a refused read is kept, so the
 * prefix folder carries its sentence and the other kinds are still counted (spec 4.3); a defect is raised.
 */
function unreadGrants(error: unknown): EtcdGrants {
  if (error instanceof DatabaseError) return { state: "refused", refusal: error };
  throw error;
}

export class EtcdProvider extends BaseDatabaseProvider {
  private session: EtcdSession | null = null;
  /** Set by the adapter's `onAuthStoreChanged` (R13 D10): the next walk that reads keys reads the grants again. */
  private grantsStale = false;
  /** One read of the grants that walks starting together share. */
  private pendingGrants: Promise<EtcdGrants> | undefined;
  private readonly running = new Map<string, RunningQuery>();

  /**
   * Validates nothing and opens nothing (spec 3.1): the connection's rules of E1, E2 and E5 run in
   * `connect()`, before the factory, so a provider built only for its declarations (the factory's census,
   * `POST /api/db/provider-meta`, a route refusing an unconnected request) touches no socket.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly createClient: EtcdClientFactory<EtcdConnectionOptions> = createGrpcEtcdClient,
  ) {
    super(config, options);
  }

  // ==========================================================================
  // Declarations (spec 6.2, 6.3)
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision (spec 6.2). */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // An etcdctl command line, declared as Redis declares its commands: "json" means only "not SQL" (spec 3.3).
      queryLanguage: "json",
      queryDialect: "etcd",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: [...ETCD_MAINTENANCE_OPERATIONS],
      maintenanceOperationSpecs: ETCD_MAINTENANCE_SPECS,
      // A key-prefix group is derived from the key space's shape, not held by the server (spec 4.1).
      tablesAreDerivedGroupings: true,
      statementTerminator: "none",
      defaultPort: ETCD_DEFAULT_PORT,
      containerLevels: [],
      objectKinds: ETCD_OBJECT_KINDS,
      keyScan: ETCD_KEY_SCAN,
      enforcesReadOnly: true,
      schemaRefreshPattern: ETCD_SCHEMA_REFRESH_PATTERN,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...ETCD_LABELS };
  }

  /** The command carries its own bounds (spec 5.4): no limit is added, and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle (spec 6.1, 4.7, E16)
  // ==========================================================================

  public async connect(): Promise<void> {
    let client: EtcdClient | undefined;
    this.grantsStale = false;
    this.pendingGrants = undefined;
    try {
      // Refused before any client exists: E1, E2, E5 and the TLS panel check of spec 6.1.
      const options = buildEtcdConnectionOptions(this.config, {
        executionReadOnly: this.execution.readOnly === true,
        queryTimeout: this.queryTimeout,
      });
      const errors = etcdErrorConnection(options);
      client = await this.createClient(options, {
        onAuthStoreChanged: () => {
          this.grantsStale = true;
        },
      }).catch((error: unknown) => {
        throw toProviderError(error, { command: "connection", write: false, connection: errors });
      });
      this.session = await this.openSession(client, options, errors);
    } catch (error) {
      // A client that was built holds a channel, so a connect that fails after it closes it (spec E16). A
      // close that fails too is logged, never thrown over the failure that explains the connect.
      await client?.close().catch((closeError: unknown) => this.logError("connect cleanup", closeError));
      // Every failure above is an Error: the mapping throws DatabaseConfigError, and the factory's and each
      // step's pass through the error table, which answers an Error for any thrown value.
      this.setError(error as Error);
      throw error;
    }
    this.setConnected(true);
  }

  /** Closes the one channel (spec E16). */
  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.grantsStale = false;
    this.pendingGrants = undefined;
    this.setConnected(false);
    await session?.client.close();
  }

  /** The deadline of a surface's or a command's calls, the connection's query timeout (spec 5.3). */
  private callSignal(): AbortSignal {
    return AbortSignal.timeout(this.queryTimeout);
  }

  /**
   * The connect sequence of spec 6.1, each step with its own sentence, then the reads of 4.7. The steps run
   * in the order 6.1 numbers them: a password signs in first (1); with no password, AuthStatus runs without
   * a token (2); authentication on with no credential is refused before any other call (3); in certificate
   * mode the Common Name's user is read (4); then Status, AuthStatus unless step 2 answered it, and the grants
   * (5), reusing step 4's roles. A member whose Status names no leader refuses the connection at once (4.7).
   *
   * Each step is one call, and its deadline is the gRPC deadline the adapter sets on every call, the same query
   * timeout (spec 5.3), with no timer of the provider's own: grpc-js words that deadline by whether the call was
   * still waiting for its connection, a connection error (spec 5.6).
   */
  private async openSession(
    client: EtcdClient,
    options: EtcdConnectionOptions,
    errors: EtcdErrorConnection,
  ): Promise<EtcdSession> {
    const step = (command: string): EtcdErrorContext => ({ command, write: false, connection: errors });
    const steps = new AbortController();
    const signal = () => steps.signal;
    const { auth, principal } = options;

    if (auth.kind === "password") {
      await client.authenticate({ signal: signal() }).catch((error: unknown) => {
        throw stepError("authenticate", error, step("sign-in"));
      });
    }
    let authStatus: EtcdAuthStatus | undefined;
    let roles: readonly string[] | undefined;
    if (auth.kind !== "password") {
      // Below 3.7, "user name is empty" here means authentication is on, and answers no revision (spec 6.1).
      authStatus = await client.authStatus({ signal: signal() }).catch((error: unknown) => {
        if (isUserNameEmpty(error)) return undefined;
        throw toProviderError(error, step("auth status"));
      });
      const enabled = authStatus?.enabled ?? true;
      if (enabled && principal === undefined) throw connectStepError("credential-required", undefined, step("sign-in"));
      if (enabled && principal !== undefined) {
        roles = await client.userGet(principal.name, { signal: signal() }).catch((error: unknown) => {
          throw stepError("certificate-user", error, step("user get"), principal.name);
        });
      }
    }
    const status = await client.status({ signal: signal() }).catch((error: unknown) => {
      throw toProviderError(error, step("endpoint status"));
    });
    if (status.leader === "0") {
      throw toProviderError(
        new EtcdError("no-leader", "the answering member's Status names no leader"),
        step("endpoint status"),
      );
    }
    // The grants are taken under an AuthStatus answer: step 2's, or one read now, a password's included (spec 4.7).
    if (authStatus === undefined) {
      authStatus = await client.authStatus({ signal: signal() }).catch((error: unknown) => {
        throw toProviderError(error, step("auth status"));
      });
    }
    const user = authStatus.enabled ? principal?.name : undefined;
    const grants = user === undefined ? EVERY_KEY : await readGrants(client, user, roles, errors, signal);
    return { client, options, errors, ...(user === undefined ? {} : { user }), grants, authStatus };
  }

  private requireSession(): EtcdSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session!;
  }

  /**
   * The grants a walk that reads keys runs under (spec 4.7): AuthStatus first, then every key where an admin has
   * turned authentication off, as a connect with it off reads them, or the user's grants read again where it is
   * on and its answer is not the one they were taken under. etcd checks its default simple token at the auth
   * store's revision as it stands, so no call made after an auth change meets "revision of auth store is old"
   * and reaches the adapter's hook, and AuthStatus is what tells the walk: its `enabled` as well as its revision,
   * since an auth enable moves no revision. The one session that reads nothing before its walks is one that
   * connected with authentication off, which has no user whose grants to read: if an admin turns authentication
   * on, etcd's own refusal answers its walks until it connects again. Every other session holds an AuthStatus
   * answer to compare, on an etcd below 3.7 too, where only root connects with authentication on
   * (`EtcdSession.authStatus`).
   */
  private async walkGrants(session: EtcdSession): Promise<EtcdGrants> {
    if (this.pendingGrants !== undefined) return this.pendingGrants;
    if (session.user === undefined) return session.grants;
    return this.readGrantsAgain(session, session.user);
  }

  /**
   * AuthStatus, then the grants its answer calls for: the ones kept where it is the answer they were taken under
   * and the adapter reported no change since, every key with no read where authentication is off, and else
   * UserGet and RoleGet read again. The grants and the answer they were taken under replace the ones kept. Walks
   * that start together share the one read.
   */
  private readGrantsAgain(session: EtcdSession, user: string): Promise<EtcdGrants> {
    const signal = () => this.callSignal();
    const replace = (): Promise<EtcdGrants> => {
      this.grantsStale = false;
      return readGrants(session.client, user, undefined, session.errors, signal).then(
        (grants) => {
          session.grants = grants;
          return grants;
        },
        (error: unknown) => {
          // Read again at the next walk: the change it would have read has not been read yet.
          this.grantsStale = true;
          throw error;
        },
      );
    };
    const reading = readAuthStatus(session.client, user, session.errors, signal())
      .then((status) => {
        const kept = session.authStatus;
        const unchanged = status.enabled === kept.enabled && status.authRevision === kept.authRevision;
        if (!this.grantsStale && unchanged) return session.grants;
        if (!status.enabled) {
          // etcd checks no grant with authentication off, so there is none to read (spec 4.7).
          this.grantsStale = false;
          session.grants = EVERY_KEY;
          session.authStatus = status;
          return EVERY_KEY;
        }
        return replace().then((grants) => {
          session.authStatus = status;
          return grants;
        });
      })
      .finally(() => {
        this.pendingGrants = undefined;
      });
    this.pendingGrants = reading;
    return reading;
  }

  /**
   * One call of a surface that walks no key, over the grants as they stand: they decide none of its requests, so
   * nothing is read before the surface's own. They word its refusals, which name the user and what it may read as
   * the grants were last read, so after an auth-store change a refusal can name a range the user has lost, or
   * leave out one it gained, until the next walk reads them again (spec 4.7).
   */
  private standingSurface(): SurfaceCall {
    const session = this.requireSession();
    return this.surfaceOver(session, session.grants);
  }

  /** One walk that reads keys, over the grants read again first where they changed (spec 4.7). */
  private async walkSurface(): Promise<SurfaceCall> {
    const session = this.requireSession();
    return this.surfaceOver(session, await this.walkGrants(session));
  }

  /**
   * The client and the context of one surface call over `grants`: its own deadline, the user the connection signs
   * in as, and whether the grants scope it (spec 3.5, 4.7).
   */
  private surfaceOver(session: EtcdSession, grants: EtcdGrants): SurfaceCall {
    const scopes = grants.state === "read" ? grants : { readable: NO_KEY, writable: NO_KEY };
    const { principal, readOnly } = session.options;
    return {
      client: session.client,
      grants,
      context: {
        readable: scopes.readable,
        writable: scopes.writable,
        // Named wherever the connection names a user, root included, since grants last read as root's can be
        // stale and etcd's refusal of a listing or of maintenance then names who signs in (spec 4.3, 7.2).
        // EVERY_KEY, root's and auth off's, scopes nothing; any other grants scope the user, a refused read of
        // them included (spec 4.7).
        ...(principal === undefined ? {} : { principal }),
        ...(grants === EVERY_KEY ? { unscoped: true as const } : {}),
        ...(readOnly === undefined ? {} : { readOnly }),
        signal: this.callSignal(),
        now: () => Date.now(),
        errors: session.errors,
      },
    };
  }

  // ==========================================================================
  // Query path (spec 5)
  // ==========================================================================

  /** The bounds a command is parsed under (spec 5.1.2, 5.1.4, 5.3, 5.4). */
  private parseLimits(): EtcdParseLimits {
    return {
      maxLimit: DEFAULT_QUERY_LIMIT,
      txnRangeLimit: ETCD_READ_BOUNDS.firstPageSize,
      maxCommandTimeoutMs: this.queryTimeout,
      maxWatchWindowMs: Math.max(0, this.queryTimeout - ETCD_READ_BOUNDS.watchMarginMs),
    };
  }

  /**
   * One typed command, sent as written over the grants as they stand (spec 4.7): nothing is read before its own
   * requests, so a command that needs no leader, a serializable get among them, still answers during a lost quorum
   * after an auth-store change. executeCommand gives E6's refusal and E8's prefix and key half first, with no
   * request; E8's lease half reads the lease's keys first, with one LeaseTimeToLive with keys, and its content rule
   * reads the command's single-key write targets first, so those refusals follow that read (spec E8). The grants
   * only word a refusal etcd gives, which names what the user may read as they were last read, as a surface that
   * walks no key does (`standingSurface`), until the next walk reads them again.
   */
  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // An etcdctl command has no binding, and dropping the values would run another command than the one
    // the caller built. An empty list binds nothing and is not a refusal (spec 5.4).
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(BOUND_PARAMS_MESSAGE, this.type);
    const session = this.requireSession();
    const parsed = parseEtcdCommand(text, this.parseLimits());
    if (!parsed.ok) throw new QueryError(parsed.refusal.message, this.type);

    const run: RunningQuery = { controller: new AbortController(), writeSent: false };
    if (queryId !== undefined) this.running.set(queryId, run);
    try {
      const { grants } = session;
      // Read grants of a user who is not root, whatever they read; EVERY_KEY is root's and auth off's (spec 4.7, 5.6).
      const readable =
        session.user !== undefined && grants.state === "read" && grants !== EVERY_KEY
          ? { user: session.user, ranges: describeScope(grants.readable) }
          : undefined;
      const started = Date.now();
      const outcome = await executeCommand(session.client, parsed.parsed, {
        ...(session.options.readOnly === undefined ? {} : { readOnly: session.options.readOnly }),
        bounds: { ...ETCD_READ_BOUNDS, rowLimit: DEFAULT_QUERY_LIMIT, queryTimeoutMs: this.queryTimeout },
        signal: AbortSignal.any([run.controller.signal, this.callSignal()]),
        endpoint: endpointText(session.options.endpoint),
        now: () => Date.now(),
        setTimer: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
        errors: session.errors,
        ...(readable === undefined ? {} : { readable }),
        onWriteSent: () => {
          run.writeSent = true;
        },
      });
      return commandResult(outcome, { executionTime: Date.now() - started, cellLimit: ETCD_READ_BOUNDS.cellLimit });
    } finally {
      if (queryId !== undefined && this.running.get(queryId) === run) this.running.delete(queryId);
    }
  }

  /**
   * Stops a read or a watch in flight and answers true (spec 5.5). A write already sent answers false:
   * aborting the call cannot undo a request etcd may have applied, and the cancel route passes that on.
   */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const run = this.running.get(queryId);
    if (run === undefined || run.writeSent) return false;
    run.controller.abort(new DOMException("The query was cancelled", "AbortError"));
    return true;
  }

  // ==========================================================================
  // Object surface (spec 4), answered by objects.ts, key-scan.ts and edit.ts
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    requireRoot(container);
    const session = this.requireSession();
    // The grants scope the prefix count alone, so a read of them that fails is kept for that folder, and the
    // other kinds are counted all the same: the members, which a lost quorum still serves, among them (spec 4.3).
    const grants = await this.walkGrants(session).catch(unreadGrants);
    const { client, context } = this.surfaceOver(session, grants);
    const counts = await countEtcdObjects(client, context);
    // A refused read of the grants is the group folder's own sentence (spec 4.7), never a count of no range.
    return grants.state === "refused" ? { ...counts, [GROUP_KIND]: { unavailable: grants.refusal.message } } : counts;
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    requireRoot(container);
    const walks = kind === GROUP_KIND;
    const { client, grants, context } = walks ? await this.walkSurface() : this.standingSurface();
    if (walks) requireKeysReadable(grants);
    return listEtcdObjects(client, context, kind);
  }

  /** A group's columns are fixed, so no read is made (spec 4.2). */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    return describeEtcdObject(path, kind);
  }

  /** One listing and no per-object read (spec 4.2); a kind with no columns is not listed at all. */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    requireRoot(container);
    if (!kindHasColumns(findKind(this.getCapabilities(), kind))) {
      this.ensureConnected();
      return describeEtcdObjects(kind, [], limit);
    }
    return describeEtcdObjects(kind, await this.listObjects(container, kind), limit);
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const walks = kind === KEY_KIND;
    // A path that names no key is refused before the walk reads the grants, so it sends nothing (spec 4.4, 5.6).
    if (walks) keyOfSourcePath(path);
    const { client, grants, context } = walks ? await this.walkSurface() : this.standingSurface();
    if (walks) requireKeysReadable(grants);
    return readEtcdObjectSource(client, context, path, kind, limit);
  }

  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    // The options are read before the walk reads the grants, so a refusal they meet sends nothing (spec 4.6, 5.6).
    readKeyScanOptions(options);
    const { client, grants, context } = await this.walkSurface();
    requireKeysReadable(grants);
    return scanEtcdKeysPage(client, context, options);
  }

  /**
   * The stamp is the composition root's (spec 4.5): the fingerprint both edit routes compare with the
   * connection they resolved, a fresh id the apply's audit files it under, and the time, as Redis stamps.
   * A refusal the build gives with no read, a read-only connection's (E6) and a protected key's (E8) among
   * them, is given before the walk reads the grants, so it sends nothing, the auth store's revision included.
   */
  public async buildObjectEdit(request: ObjectEditRequest): Promise<ObjectEditBuild> {
    const session = this.requireSession();
    const refused = refuseValueEditBeforeRead(session.options, request);
    if (refused !== undefined) return refused;
    const grants = await this.walkGrants(session);
    requireKeysReadable(grants);
    const { client, context } = this.surfaceOver(session, grants);
    return buildEtcdValueEdit(client, context, request, {
      type: this.type,
      connectionFingerprint: await connectionFingerprint(this.config),
      planId: randomUUID(),
      issuedAt: new Date().toISOString(),
    });
  }

  /**
   * The plan the build made, sent as its one Txn; a read-only provider answers `refused` (spec 4.5, E6). Nothing
   * is read before the Txn, the grants after an auth-store change included, which the next walk reads (R13 D10):
   * here they only name what a refusal says the user may read, and a read of them that failed would be thrown
   * before the send, which the apply route reports as an edit whose outcome is unknown.
   */
  public async applyObjectEdit(plan: ObjectEditPlan): Promise<ObjectEditOutcome> {
    const session = this.requireSession();
    const { client, context } = this.surfaceOver(session, session.grants);
    return applyEtcdValueEdit(client, context, plan);
  }

  // ==========================================================================
  // Monitoring and maintenance (spec 7), answered by monitoring-reads.ts and maintenance.ts
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    const { client, context } = this.standingSurface();
    return readEtcdHealth(client, context);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const { client, grants, context } = await this.walkSurface();
    requireKeysReadable(grants);
    return readEtcdOverview(client, context);
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const { client, context } = this.standingSurface();
    return readEtcdStorageStats(client, context);
  }

  /** One count per listed group, over its readable intersection, read when the panel opens (spec 7.1). */
  public async getTableStats(): Promise<TableStats[]> {
    const { client, grants, context } = await this.walkSurface();
    requireKeysReadable(grants);
    const groups = await listEtcdObjects(client, context, GROUP_KIND);
    return readEtcdTableStats(client, context, groups.map(groupPrefix));
  }

  /** Every metric is optional, so an empty object is the honest answer: etcd's API reports none (spec 7.1). */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: etcd keeps no query log. `getLabels().slowQueriesEmptyState` says so in the panel. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: etcd does not report client sessions. `getLabels().sessionsEmptyState` says so in the panel. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: etcd has no index. */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  /**
   * Compaction, defragmentation and alarm disarm (spec 7.2), each declared global and never per entity, so
   * the maintenance route refuses a target for them before this is reached (`maintenanceControl`).
   */
  public async runMaintenance(type: MaintenanceOperation): Promise<MaintenanceResult> {
    const { client, context } = this.standingSurface();
    return runEtcdMaintenance(client, context, type);
  }
}
