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
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
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
import { type EtcdClient, type EtcdClientFactory, EtcdError, type EtcdPermission } from "./client";
import { type EtcdParseLimits, parseEtcdCommand } from "./commands";
import {
  buildEtcdConnectionOptions,
  ETCD_DEFAULT_PORT,
  type EtcdConnectionOptions,
  etcdErrorConnection,
} from "./connection-options";
import { applyEtcdValueEdit, buildEtcdValueEdit } from "./edit";
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
import { ETCD_KEY_SCAN, scanEtcdKeysPage } from "./key-scan";
import { ETCD_LABELS } from "./labels";
import { ETCD_MAINTENANCE_OPERATIONS, ETCD_MAINTENANCE_SPECS, runEtcdMaintenance } from "./maintenance";
import { readEtcdHealth, readEtcdOverview, readEtcdStorageStats, readEtcdTableStats } from "./monitoring-reads";
import {
  countEtcdObjects,
  describeEtcdObject,
  describeEtcdObjects,
  ETCD_OBJECT_KINDS,
  type EtcdSurfaceContext,
  listEtcdObjects,
  readEtcdObjectSource,
} from "./objects";
import { type AccessScope, describeScope, ROOT_ROLE, readableScope, writableScope } from "./permissions";
import { commandResult } from "./results";

const BOUND_PARAMS_MESSAGE = "Bound params are not supported: an etcdctl command has no placeholders";

/** A backslash-newline at a CRLF, CR or LF line end, which joins two lines outside single quotes (spec 5.1.1). */
const LINE_JOIN = String.raw`\\(?:\r\n?|\n)`;

/** Quote marks, which a word may hold anywhere: the lexer removes them and keeps the text they quote (spec 5.1.1). */
const QUOTES = `['"]*`;

/** The blanks between two words of the command line, with a line join before them, after them or both. */
const WORD_GAP = String.raw`(?:${LINE_JOIN})?[ \t]+(?:${LINE_JOIN}[ \t]*)?`;

/** Blank lines before the command, a line join among them. */
const BLANK_LINES = String.raw`\s*(?:\\[\r\n]\s*)*`;

/** `text` from inside a word on: each character bare or escaped, with quote marks between them and after the last. */
function spelledFrom(text: string): string {
  const characters = [...text].map((char) => String.raw`\\?${char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`);
  return `${characters.join(QUOTES)}${QUOTES}`;
}

/** A word whose text is `text`, as the lexer reads it (spec 5.1.1). */
const spelledWord = (text: string): string => `${QUOTES}${spelledFrom(text)}`;

/** `--command-timeout` and its value, after `=` or a gap, then the gap before the next word (spec 5.1.2). */
const COMMAND_TIMEOUT = String.raw`${spelledWord("--command-timeout")}(?:\\?=|${WORD_GAP})\S+${WORD_GAP}`;

/** `lease grant` and `lease revoke`, which add and remove what the Leases folder lists (spec 6.2). */
const LEASE_WRITE = [
  spelledWord("lease"),
  WORD_GAP,
  `(?:${COMMAND_TIMEOUT})*`,
  `(?:${spelledWord("grant")}|${spelledWord("revoke")})`,
].join("");

/**
 * Anchored to the command word the parser reads (spec 6.2): past the blank and comment lines before it, the
 * leading tokens of spec 5.1.2 and `--command-timeout`, so a key named like a verb reloads nothing. Each word
 * may be spelled as the lexer reads it, with quote marks anywhere in it and any character escaped, and a line
 * join may stand at either end of the blanks between two words, so the documented multi-line forms reload the
 * tree (5.1.1). A line join inside a word, or two in one gap, is not read: patterns that read them took
 * JavaScriptCore, the engine of Bun and Safari, 6.8 s on 20,000 joins in one gap and 38 s on 80,000
 * assignments (measured 2026-10-01), where this one decides each in under 0.2 s. `shouldRefreshSchema`
 * compiles it with `i` alone, so `^` is the start of the whole buffer.
 */
const SCHEMA_REFRESH_PATTERN = [
  String.raw`^(?:${BLANK_LINES}#[^\n]*\n)*${BLANK_LINES}`,
  `(?:[$%]${WORD_GAP})?`,
  `(?:${spelledWord("env")}${WORD_GAP})?`,
  `(?:ETCDCTL_API=${QUOTES}${spelledFrom("3")}${WORD_GAP})*`,
  String.raw`(?:(?:\S*/)?${QUOTES}${spelledFrom("etcdctl")}${WORD_GAP})?`,
  `(?:${COMMAND_TIMEOUT})*`,
  `(?:${["put", "del", "txn"].map(spelledWord).join("|")}|${LEASE_WRITE})`,
  String.raw`(?=(?:${LINE_JOIN})?(?:\s|$))`,
].join("");

/** The kind that groups keys (spec 4.1): the one the grants scope, and whose names end in `*`. */
const GROUP_KIND = "prefix";

/** The two kinds whose reads walk keys, the only reads a user's grants scope (spec 4.7). */
const KEY_READING_KINDS: ReadonlySet<string> = new Set([GROUP_KIND, "key"]);

/** What this connection may read and write (spec 4.7), or the refusal met reading its grants. */
type EtcdGrants =
  | { readonly state: "read"; readonly readable: AccessScope; readonly writable: AccessScope }
  | { readonly state: "refused"; readonly refusal: Error };

/**
 * Root, or authentication off: every key, and no user a surface names. Told apart by identity: the grants
 * of a user who is not root and may read every key are another object, and that user is named (spec 4.7).
 */
const EVERY_KEY: EtcdGrants = { state: "read", readable: { kind: "all" }, writable: { kind: "all" } };

/** The scope of a surface whose grants could not be read: no range, so nothing is read outside a grant. */
const NO_KEY: AccessScope = { kind: "ranges", ranges: [] };

/** The one channel of a connected provider and what it learned while connecting (spec E16). */
interface EtcdSession {
  readonly client: EtcdClient;
  readonly options: EtcdConnectionOptions;
  readonly errors: EtcdErrorConnection;
  /** The etcd user the grants belong to; absent where authentication is off. */
  readonly user?: string;
  grants: EtcdGrants;
}

/** A query in flight under the caller's id, so cancelQuery reaches it (spec 5.5). */
interface RunningQuery {
  readonly controller: AbortController;
  writeSent: boolean;
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
  const context: EtcdErrorContext = { command: `read of etcd user ${user}'s grants`, write: false, connection: errors };
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

export class EtcdProvider extends BaseDatabaseProvider {
  private session: EtcdSession | null = null;
  /** Set by the adapter's `onAuthStoreChanged` (R13 D10): the grants are read again before the next surface. */
  private grantsStale = false;
  /** One read of the grants that surfaces starting together share. */
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
      schemaRefreshPattern: SCHEMA_REFRESH_PATTERN,
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

  /** Each call's own deadline, the connection's query timeout (spec 5.3). */
  private callSignal(): AbortSignal {
    return AbortSignal.timeout(this.queryTimeout);
  }

  /**
   * The connect sequence of spec 6.1, each step with its own sentence, then the reads of 4.7. The steps run
   * in the order 6.1 numbers them: a password signs in first (1); with no password, AuthStatus runs without
   * a token (2); authentication on with no credential is refused before any other call (3); in certificate
   * mode the Common Name's user is read (4); then Status, and the grants (5), reusing step 2's AuthStatus and
   * step 4's roles. A member whose Status names no leader refuses the connection at once (4.7).
   */
  private async openSession(
    client: EtcdClient,
    options: EtcdConnectionOptions,
    errors: EtcdErrorConnection,
  ): Promise<EtcdSession> {
    const step = (command: string): EtcdErrorContext => ({ command, write: false, connection: errors });
    const signal = () => this.callSignal();
    const { auth, principal } = options;

    if (auth.kind === "password") {
      await client.authenticate({ signal: signal() }).catch((error: unknown) => {
        throw stepError("authenticate", error, step("sign-in"));
      });
    }
    let enabled: boolean | undefined;
    let roles: readonly string[] | undefined;
    if (auth.kind !== "password") {
      enabled = await client.authStatus({ signal: signal() }).then(
        (status) => status.enabled,
        (error: unknown) => {
          if (isUserNameEmpty(error)) return true;
          throw toProviderError(error, step("auth status"));
        },
      );
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
    if (enabled === undefined) {
      enabled = await client.authStatus({ signal: signal() }).then(
        (answer) => answer.enabled,
        (error: unknown) => {
          throw toProviderError(error, step("auth status"));
        },
      );
    }
    const user = enabled ? principal?.name : undefined;
    const grants = user === undefined ? EVERY_KEY : await readGrants(client, user, roles, errors, signal);
    return { client, options, errors, ...(user === undefined ? {} : { user }), grants };
  }

  private requireSession(): EtcdSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session!;
  }

  /** The grants as they stand, read again first after an auth-store change (R13 D10). */
  private async currentGrants(session: EtcdSession): Promise<EtcdGrants> {
    if (this.pendingGrants !== undefined) return this.pendingGrants;
    if (!this.grantsStale || session.user === undefined) return session.grants;
    this.grantsStale = false;
    const reading = readGrants(session.client, session.user, undefined, session.errors, () => this.callSignal())
      .then(
        (grants) => {
          session.grants = grants;
          return grants;
        },
        (error: unknown) => {
          // Read again at the next surface: the change it would have read has not been read yet.
          this.grantsStale = true;
          throw error;
        },
      )
      .finally(() => {
        this.pendingGrants = undefined;
      });
    this.pendingGrants = reading;
    return reading;
  }

  /** The client and the context of one surface call: its own deadline, and the grants as they stand (spec 3.5). */
  private async surface(): Promise<{
    readonly client: EtcdClient;
    readonly grants: EtcdGrants;
    readonly context: EtcdSurfaceContext;
  }> {
    const session = this.requireSession();
    const grants = await this.currentGrants(session);
    const scopes = grants.state === "read" ? grants : { readable: NO_KEY, writable: NO_KEY };
    const { principal, readOnly } = session.options;
    // Named whenever authentication is on and the user does not hold root, whatever its grants read, a
    // refused read of them included, and never otherwise (spec 4.7): EVERY_KEY is root's and auth off's.
    const named = grants === EVERY_KEY ? undefined : principal;
    return {
      client: session.client,
      grants,
      context: {
        readable: scopes.readable,
        writable: scopes.writable,
        ...(named === undefined ? {} : { principal: named }),
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
      const grants = await this.currentGrants(session);
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
    const { client, grants, context } = await this.surface();
    const counts = await countEtcdObjects(client, context);
    // A refused read of the grants is the group folder's own sentence (spec 4.7), never a count of no range.
    return grants.state === "refused" ? { ...counts, [GROUP_KIND]: { unavailable: grants.refusal.message } } : counts;
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    requireRoot(container);
    const { client, grants, context } = await this.surface();
    if (KEY_READING_KINDS.has(kind)) requireKeysReadable(grants);
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
    const { client, grants, context } = await this.surface();
    if (KEY_READING_KINDS.has(kind)) requireKeysReadable(grants);
    return readEtcdObjectSource(client, context, path, kind, limit);
  }

  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    const { client, grants, context } = await this.surface();
    requireKeysReadable(grants);
    return scanEtcdKeysPage(client, context, options);
  }

  /**
   * The stamp is the composition root's (spec 4.5): the fingerprint both edit routes compare with the
   * connection they resolved, a fresh id the apply's audit files it under, and the time, as Redis stamps.
   */
  public async buildObjectEdit(request: ObjectEditRequest): Promise<ObjectEditBuild> {
    const { client, grants, context } = await this.surface();
    requireKeysReadable(grants);
    return buildEtcdValueEdit(client, context, request, {
      type: this.type,
      connectionFingerprint: await connectionFingerprint(this.config),
      planId: randomUUID(),
      issuedAt: new Date().toISOString(),
    });
  }

  /** The plan the build made, sent as its one Txn; a read-only provider answers `refused` (spec 4.5, E6). */
  public async applyObjectEdit(plan: ObjectEditPlan): Promise<ObjectEditOutcome> {
    const { client, context } = await this.surface();
    return applyEtcdValueEdit(client, context, plan);
  }

  // ==========================================================================
  // Monitoring and maintenance (spec 7), answered by monitoring-reads.ts and maintenance.ts
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    const { client, context } = await this.surface();
    return readEtcdHealth(client, context);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const { client, grants, context } = await this.surface();
    requireKeysReadable(grants);
    return readEtcdOverview(client, context);
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const { client, context } = await this.surface();
    return readEtcdStorageStats(client, context);
  }

  /** One count per listed group, over its readable intersection, read when the panel opens (spec 7.1). */
  public async getTableStats(): Promise<TableStats[]> {
    const { client, grants, context } = await this.surface();
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
    const { client, context } = await this.surface();
    return runEtcdMaintenance(client, context, type);
  }
}
