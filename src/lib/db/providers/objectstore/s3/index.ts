/**
 * S3 provider: a read-only explorer of S3-compatible object storage. Buckets in the tree, folders and objects
 * in the Keys panel, object metadata and a bounded preview in the Source tab, a closed AWS CLI read subset in the
 * console.
 *
 * COMPOSITION AND DELEGATION ONLY. The connection rules are `connection-options.ts`, the requests `encoding.ts`, the
 * signature `sigv4.ts`, the answers `xml.ts`, `shapes.ts` and `headers.ts`, the operations `client.ts`, every
 * sentence of a failure `errors.ts`, the key space `names.ts`, the object surface `objects.ts`, the Keys panel
 * `key-scan.ts` and `cursor.ts`, the preview seam `preview-adapter.ts`, the probe, health and overview
 * `monitoring-reads.ts`. What stays here is the session's lifecycle, the declarations, the limiter, each call's
 * deadline, the run registry and the one failure path every call takes.
 *
 * One transport per session, built in `connect()` (or in `getHealth()` when no session exists) and closed at
 * `disconnect()`. Only typed keys sign: a blank pair passes no signer, so a request carries no credential at all.
 * The constructor's `deps` are test seams that the factory never passes, and no connection field reaches them, so a
 * user cannot forge time or a transport. No `getPoolStats`, no `queryReadOnly` and no
 * transaction methods: each is detected by presence.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { AuthenticationError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  createNodeByteTransport,
  type NodeByteTransport,
  type NodeByteTransportOptions,
  type RequestSigner,
} from "@/lib/db/http/node-transport";
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
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectSourceDocument,
  ObjectSourcePart,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { engineLimiter, type ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { QueryWarning } from "@/lib/types";
import {
  type BucketListing,
  createS3Client,
  limitedS3Client,
  type S3CallOptions,
  type S3Client,
  type S3ClientContext,
  type S3Operation,
  type S3Surface,
} from "./client";
import { buildS3ConnectionOptions, type S3ConnectionOptions, s3EndpointText } from "./connection-options";
import { S3_DEFAULT_PORT, S3_HEALTH_DEADLINE_MS, S3_LIMITER_OPTIONS, S3_MAX_SOCKETS, S3_TYPE } from "./constants";
import { toProviderError } from "./errors";
import { S3_RESPONSE_HEADERS } from "./headers";
import { S3_KEY_SCAN, scanS3KeysPage } from "./key-scan";
import { S3_LABELS } from "./labels";
import { probeOperation, probeS3, S3_NO_BUCKETS_WARNING, s3Health, s3Overview } from "./monitoring-reads";
import {
  countS3Objects,
  describeS3Object,
  describeS3Objects,
  listS3Objects,
  readS3ObjectSource,
  requireS3Root,
  S3_OBJECT_KINDS,
  type S3PreviewParts,
} from "./objects";
import { previewObject } from "./preview";
import { rangeReader, toPreviewHead } from "./preview-adapter";
import { previewSourceParts } from "./preview-render";
import { s3Signer } from "./sigv4";

export type { S3Surface } from "./client";

export interface S3ProviderDeps {
  createTransport: (o: NodeByteTransportOptions) => NodeByteTransport;
  clock: () => Date;
  signerWrapper: (s: RequestSigner) => RequestSigner;
}

/** One process-wide table for every S3 provider: 4 calls per provider, 16 per process, a queue of 64. */
const s3Limiter = engineLimiter("s3", S3_LIMITER_OPTIONS);

const DEFAULT_DEPS: S3ProviderDeps = {
  createTransport: createNodeByteTransport,
  clock: () => new Date(),
  signerWrapper: (signer) => signer,
};

/** One connected session: its transport, what the connection resolved to, and what every call of it shares. */
interface S3Session {
  readonly transport: NodeByteTransport;
  readonly options: S3ConnectionOptions;
  readonly context: S3ClientContext;
  /** The limited client. */
  readonly client: S3Client;
  /** Aborted at disconnect, so no call outlives its session. */
  readonly lifetime: AbortController;
  /** Bucket creation dates the tree read, for the bucket Source part. */
  readonly created: Map<string, string>;
  /**
   * The bucket list the last count read, which the next bucket listing takes once if it comes within the surface
   * deadline: plan grounding counts and then lists the bucket kind, and both are one ListBuckets.
   */
  bucketHandoff: { readonly listing: BucketListing; readonly readAtMs: number } | null;
  warnings: readonly QueryWarning[];
}

export class S3Provider extends BaseDatabaseProvider {
  private session: S3Session | null = null;
  private readonly limiter: ProviderLimiter = s3Limiter();
  private readonly deps: S3ProviderDeps;

  /**
   * Validates nothing and opens nothing: the connection's rules run in `connect()`, so a provider built only for its
   * declarations (the factory's census, `POST /api/db/provider-meta`) touches no socket.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    deps: Partial<S3ProviderDeps> = {},
  ) {
    super(config, options);
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // One AWS CLI read command per run, declared as Oxia declares its command line: "json" means only "not SQL".
      queryLanguage: "json",
      queryDialect: "s3",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Read-only whatever the flag says: the client has only GET and HEAD operations.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: S3_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: S3_OBJECT_KINDS,
      keyScan: S3_KEY_SCAN,
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...S3_LABELS };
  }

  /** The command carries its own bound: no limit is added, and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  // ==========================================================================
  // Object surface, answered by objects.ts
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    return [];
  }

  /** The bucket list this count reads is kept for the next bucket listing (`bucketHandoff`). */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    requireS3Root(container);
    const session = this.requireSession();
    session.bucketHandoff = null;
    return this.read(
      (surface, call) =>
        countS3Objects(
          {
            ...surface,
            client: {
              ...surface.client,
              listBuckets: async (options) => {
                const listing = await surface.client.listBuckets(options);
                session.bucketHandoff = { listing, readAtMs: this.deps.clock().getTime() };
                return listing;
              },
            },
          },
          call,
        ),
      "ListBuckets",
    );
  }

  /** Takes the count's bucket list once when it is younger than the surface deadline; otherwise reads its own. */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    requireS3Root(container);
    const session = this.requireSession();
    const handoff = session.bucketHandoff;
    session.bucketHandoff = null;
    const kept: BucketListing | undefined =
      handoff !== null && this.deps.clock().getTime() - handoff.readAtMs <= session.options.surfaceTimeoutMs
        ? handoff.listing
        : undefined;
    return this.read(
      (surface, call) =>
        listS3Objects(
          kept === undefined ? surface : { ...surface, client: { ...surface.client, listBuckets: async () => kept } },
          kind,
          call,
          session.created,
        ),
      "ListBuckets",
    );
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeS3Object(path, kind);
  }

  public async describeObjects(container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    requireS3Root(container);
    return describeS3Objects(kind);
  }

  /** A bucket's three parts, or an object's Metadata part and its preview parts. */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return this.read(
      (surface, call) =>
        readS3ObjectSource(surface, path, kind, limit, call, {
          created: this.requireSession().created,
          previewParts: (input) => this.previewParts(surface, input),
        }),
      kind === "bucket" ? "GetBucketLocation" : "HeadObject",
    );
  }

  /**
   * The object preview after the HEAD, through the one adapter: no second HEAD, every ranged GET under the call's one
   * deadline and its own permit. A refusal is the Preview part's sentence; anything else fails the document.
   */
  private async previewParts(
    surface: S3Surface,
    input: Parameters<S3PreviewParts>[0],
  ): Promise<readonly ObjectSourcePart[]> {
    const head = toPreviewHead(input.head, input.bucket, input.key);
    if (typeof head === "string") return [{ id: "preview", label: "Preview", unavailable: head }];
    try {
      const preview = await previewObject({
        head,
        reader: rangeReader(surface.client, input.bucket, input.key, input.call),
        request: {},
        purpose: "source",
        signal: input.call.signal,
      });
      return previewSourceParts(preview, {
        bucket: input.bucket,
        key: input.key,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    } catch (error) {
      const failure = surface.fail(error, "GetObject");
      if (
        failure instanceof QueryError ||
        failure instanceof AuthenticationError ||
        failure instanceof DatabaseConfigError
      )
        return [{ id: "preview", label: "Preview", unavailable: failure.message }];
      throw failure;
    }
  }

  // ==========================================================================
  // Keys panel, answered by key-scan.ts
  // ==========================================================================

  /** Options and cursor are refused by key-scan.ts before any request; a page is one server call at most. */
  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    return this.read((surface, call) => scanS3KeysPage(surface, options, call), "ListObjectsV2");
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** The options, the transport, and the probe; a session is kept only after its probe parsed as S3 XML. */
  public async connect(): Promise<void> {
    if (this.session !== null) await this.disconnect();
    const session = this.openSession();
    await this.probe(session);
    this.session = session;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    if (session === null) return;
    session.lifetime.abort();
    session.transport.close();
  }

  /** The no-bucket notice of an unpinned probe that listed none; [] before a connect and after disconnect. */
  public connectWarnings(): QueryWarning[] {
    return this.session === null ? [] : [...this.session.warnings];
  }

  /** The options, the transport and the limited client, with no request: connect and health share it. */
  private openSession(): S3Session {
    // Refused before any transport exists: every connection rule, already worded.
    const options = buildS3ConnectionOptions(this.config, {
      executionReadOnly: this.execution.readOnly === true,
      queryTimeout: this.queryTimeout,
    });
    const signer =
      options.credentials === null
        ? undefined
        : this.deps.signerWrapper(s3Signer(options.credentials, options.region, this.deps.clock));
    const transport = this.deps.createTransport({
      origin: options.origin,
      tls: options.tls,
      maxSockets: S3_MAX_SOCKETS,
      headers: {},
      requestHeaderNames: ["range"],
      responseHeaders: S3_RESPONSE_HEADERS,
      ...(signer === undefined ? {} : { signer }),
    });
    return {
      transport,
      options,
      context: {
        region: options.region,
        signs: options.credentials !== null,
        clock: this.deps.clock,
        secretForms: options.secretForms,
        endpointText: s3EndpointText(options),
      },
      client: limitedS3Client(createS3Client(transport), this.limiter),
      lifetime: new AbortController(),
      created: new Map(),
      bucketHandoff: null,
      warnings: [],
    };
  }

  /** Connect's probe under the surface deadline; a failure is worded, then the session's transport is closed. */
  private async probe(session: S3Session): Promise<void> {
    const timeoutMs = session.options.surfaceTimeoutMs;
    const surface = this.surfaceFor(session, timeoutMs);
    try {
      const { listedBuckets } = await probeS3(surface, this.callFor(session, timeoutMs));
      session.warnings = listedBuckets === 0 ? [{ message: S3_NO_BUCKETS_WARNING }] : [];
    } catch (error) {
      // Worded before the lifetime ends, so a defect is never turned into the closed-connection sentence.
      const failure = surface.fail(error, probeOperation(session.options));
      session.lifetime.abort();
      session.transport.close();
      throw failure;
    }
  }

  // ==========================================================================
  // The surface every module reads through
  // ==========================================================================

  private requireSession(): S3Session {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as S3Session;
  }

  /** One session's limited client and the failure path of a call that ran under `timeoutMs` and `signal`. */
  private surfaceFor(session: S3Session, timeoutMs: number, signal?: AbortSignal): S3Surface {
    return {
      client: session.client,
      options: session.options,
      fail: (error, operation) =>
        toProviderError(error, operation, session.context, {
          lifetime: session.lifetime.signal,
          timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        }),
    };
  }

  /** A call's signal carries the session's lifetime (or a run's signal) and the deadline, so a permit wait counts inside it. */
  private callFor(session: S3Session, timeoutMs: number, signal: AbortSignal = session.lifetime.signal): S3CallOptions {
    return { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), deadline: Date.now() + timeoutMs };
  }

  /** A surface read under the surface deadline; a failure the module did not word is worded with `operation`. */
  private async read<T>(
    work: (surface: S3Surface, call: S3CallOptions) => Promise<T>,
    operation?: S3Operation,
  ): Promise<T> {
    const session = this.requireSession();
    const timeoutMs = session.options.surfaceTimeoutMs;
    const surface = this.surfaceFor(session, timeoutMs);
    try {
      return await work(surface, this.callFor(session, timeoutMs));
    } catch (error) {
      throw surface.fail(error, operation ?? probeOperation(session.options));
    }
  }

  // ==========================================================================
  // Monitoring, answered by monitoring-reads.ts
  // ==========================================================================

  /**
   * The probe under the health deadline. A provider with no session builds one without the connect probe, keeps it
   * when health answers and closes it when health fails, Oxia's rule.
   */
  public async getHealth(): Promise<HealthInfo> {
    const opened = this.session === null;
    const session = this.session ?? this.openSession();
    const timeoutMs = Math.min(S3_HEALTH_DEADLINE_MS, session.options.callTimeoutMs);
    const surface = this.surfaceFor(session, timeoutMs);
    try {
      const health = await s3Health(surface, this.callFor(session, timeoutMs));
      if (opened) {
        this.session = session;
        this.setConnected(true);
      }
      return health;
    } catch (error) {
      const failure = surface.fail(error, probeOperation(session.options));
      if (opened) {
        session.lifetime.abort();
        session.transport.close();
      }
      throw failure;
    }
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return this.read((surface, call) => s3Overview(surface, call));
  }

  /** S3 reports no storage figure Studio could chart. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  /** S3 has no tables; `tableStatsCaption` says where its buckets and objects are. */
  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  /** S3 keeps no query log. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  /** S3 does not list client sessions. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  /** Nothing is measured, so every optional figure is absent. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return {};
  }

  /** `supportsMaintenance: false`: nothing sends maintenance, and a direct call is refused in the label's words. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(S3_LABELS.vacuumGlobalDesc, S3_TYPE);
  }
}
