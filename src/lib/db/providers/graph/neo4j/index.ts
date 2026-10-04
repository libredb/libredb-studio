/**
 * Neo4j provider. Read-only Cypher over Bolt against Neo4j 5.26: node labels, relationship types, indexes and
 * constraints in the tree, one statement per run in the editor, and the monitoring panels.
 *
 * DECLARATIONS AND MONITORING ONLY (spec 6.1, 6.2, 7; revisions SR4, SR15). The query path, the object
 * surface, the cancel and the catalog cache are `GraphBaseProvider`'s; this class hands it the engine profile
 * (the policy lists of profile.ts, the port, the statement gate of statement-gate.ts, the catalog of
 * catalog.ts and the error table of errors.ts), writes every capability out, reads the kernel's version at
 * connect, and delegates the monitoring reads to monitoring-reads.ts, whose answers monitoring.ts shapes.
 *
 * A server outside 5.26 connects and is reported untested in the overview's version. A failed version read
 * does not fail the connection, so the overview then says the version is unknown, unless the server answers
 * that the connection's database does not exist.
 */
import { createBoltClient } from "@/lib/db/graph/bolt/bolt-client";
import type { GraphClientFactory } from "@/lib/db/graph/bolt/client";
import { GraphClientError } from "@/lib/db/graph/bolt/client";
import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";
import { type GraphEngineProfile, GraphBaseProvider } from "@/lib/db/graph/graph-base-provider";
import { GRAPH_CONTAINER_LEVELS, GRAPH_OBJECT_KINDS } from "@/lib/db/graph/objects";
import type {
  ActiveSessionDetails,
  DatabaseConnection,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { neo4jCatalog } from "./catalog";
import { mapNeo4jError } from "./errors";
import { neo4jLabels } from "./labels";
import { type Neo4jServerVersion, toHealthInfo } from "./monitoring";
import {
  readActiveSessions,
  readIndexStats,
  readOverview,
  readPing,
  readServerVersion,
  readTableStats,
} from "./monitoring-reads";
import { NEO4J_POLICY_PROFILE } from "./profile";
import { neo4jStatementGate } from "./statement-gate";

/** Bolt's registered port. */
const NEO4J_DEFAULT_PORT = 7687;

/** The whole engine profile: the pure policy half and the server half (SR15: no execution hook beyond these). */
export const NEO4J_ENGINE_PROFILE: GraphEngineProfile = {
  ...NEO4J_POLICY_PROFILE,
  defaultPort: NEO4J_DEFAULT_PORT,
  statementGate: neo4jStatementGate,
  catalog: neo4jCatalog,
  mapError: mapNeo4jError,
};

/** The status code of a run on a database the server does not hold. */
const DATABASE_NOT_FOUND = "Neo.ClientError.Database.DatabaseNotFound";

/** A pattern no statement matches: a read-only connection runs nothing that changes the schema (SR20). */
const SCHEMA_REFRESH_NEVER = "(?!)";

type MonitoringRead<T> = (client: Parameters<typeof readPing>[0], database: string) => Promise<T>;

export class Neo4jProvider extends GraphBaseProvider {
  /** The kernel's version and edition, read at connect; undefined when that read failed. */
  private server: Neo4jServerVersion | undefined;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, createClient?: GraphClientFactory) {
    // The composition root chooses the transport: Bolt, with the client factory a test injects.
    super(config, options, NEO4J_ENGINE_PROFILE, {
      endpointOf: boltEndpointOf,
      createClient: createClient ?? createBoltClient,
    });
  }

  // ==========================================================================
  // Declarations (spec 6.2, 6.3)
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision (spec 6.2). */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "cypher",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      // A label is a name the server holds, not a grouping this server derived.
      tablesAreDerivedGroupings: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: NEO4J_DEFAULT_PORT,
      statementTerminator: "none",
      // One container, the database (SR4), and every address names it. `containerPathShapes` is left absent,
      // which the kernel reads as `exact`: GraphBaseProvider refuses any other container with a check of its
      // own rather than `assertContainerPathShape`, as etcd and Kafka do with theirs.
      containerLevels: GRAPH_CONTAINER_LEVELS,
      objectKinds: GRAPH_OBJECT_KINDS,
      schemaRefreshPattern: SCHEMA_REFRESH_NEVER,
    };
  }

  public override getLabels(): ProviderLabels {
    return neo4jLabels();
  }

  // ==========================================================================
  // Lifecycle (spec 6.1)
  // ==========================================================================

  /**
   * The base's connect, then the kernel's version, read once on the connection's database. The base's verify
   * never touches that database, so this read is the first that does: a database the server does not hold
   * fails the connect, and the client is closed. Any other failure of the read is logged and leaves the
   * version unknown.
   */
  public override async connect(): Promise<void> {
    await super.connect();
    try {
      this.server = await readServerVersion(this.client(), this.database());
    } catch (error) {
      this.server = undefined;
      if (error instanceof GraphClientError && error.code === DATABASE_NOT_FOUND) {
        await this.disconnect().catch((closeError: unknown) => this.logError("connect cleanup", closeError));
        const mapped = this.profile.mapError(error);
        this.setError(mapped);
        throw mapped;
      }
      this.logError("server version read", error);
    }
  }

  // ==========================================================================
  // Health and monitoring (spec 7), answered by monitoring-reads.ts
  // ==========================================================================

  /** After the base's verify: `CALL db.ping()` on the connection's database. */
  protected override async healthOf(): Promise<HealthInfo> {
    await this.monitored(readPing);
    return toHealthInfo();
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return this.monitored((client, database) => readOverview(client, database, this.server));
  }

  /** Every metric is optional, so an empty object is the honest answer: Bolt reports none. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: Community keeps no query log. `getLabels().slowQueriesEmptyState` says so in the panel. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return this.monitored(readActiveSessions);
  }

  public async getTableStats(): Promise<TableStats[]> {
    return this.monitored((client, database) =>
      readTableStats(client, database, (labels) => {
        const counted =
          labels.length === 1
            ? "1 label no Cypher name can spell was"
            : `${labels.length} labels no Cypher name can spell were`;
        const names = labels.map((label) => JSON.stringify(label)).join(", ");
        this.logError("table stats", `${counted} left out: ${names}`);
      }),
    );
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return this.monitored(readIndexStats);
  }

  /** Empty: Bolt reports no store size. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  /** The connected database's name; `client()` has already refused a provider that is not connected. */
  private database(): string {
    return this.currentDatabase() as string;
  }

  /** One monitoring read on the connected client, a transport failure through the error table. */
  private async monitored<T>(read: MonitoringRead<T>): Promise<T> {
    const client = this.client();
    try {
      return await read(client, this.database());
    } catch (error) {
      throw error instanceof GraphClientError ? this.profile.mapError(error) : error;
    }
  }
}
