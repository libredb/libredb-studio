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
 *
 * AGENT READ-ONLY PROFILE. A handle opened for it by an acquisition that sends statements proves at connect that its
 * user reads only (`agent-boundary.ts`), and `queryReadOnly` answers only on such a handle: the statement is read by
 * `readNeo4jAgentStatement` (`agent-statement.ts`) and refused before anything is sent when it is not an agent read,
 * then the user is proved again under the statement's own deadline, with no verdict kept from the open or the call
 * before, then the statement takes the editor's road (the statement gate, one READ run on the connection's database).
 * A result past the row or byte budget is refused, never cut. Every other handle, the operations profile's included,
 * opens unproved, so plan mode keeps grounding on a user that can write.
 */
import { createBoltClient } from "@/lib/db/graph/bolt/bolt-client";
import type { GraphClientFactory } from "@/lib/db/graph/bolt/client";
import { GraphClientError } from "@/lib/db/graph/bolt/client";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";
import { type GraphEngineProfile, GraphBaseProvider, toQueryResult } from "@/lib/db/graph/graph-base-provider";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
} from "@/lib/db/providers/sql/read-only-budget";
import { GRAPH_CONTAINER_LEVELS, GRAPH_OBJECT_KINDS } from "@/lib/db/graph/objects";
import type {
  ActiveSessionDetails,
  DatabaseConnection,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { proveNeo4jAgentPrincipal } from "./agent-boundary";
import { readNeo4jAgentStatement } from "./agent-statement";
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

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `connect()` prove the user reads only, and only then does `queryReadOnly`
   * answer.
   */
  private readonly readOnlyProfile: boolean;

  /**
   * `createClient` is the test seam of the client the connect builds: the factory passes three arguments, so a real
   * connection always builds a Bolt client.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    execution: ProviderExecutionContext = {},
    createClient?: GraphClientFactory,
  ) {
    // The composition root chooses the transport: Bolt, with the client factory a test injects.
    super(config, options, NEO4J_ENGINE_PROFILE, {
      endpointOf: boltEndpointOf,
      createClient: createClient ?? createBoltClient,
    });
    this.readOnlyProfile = execution.readOnly === true && execution.sendsStatements === true;
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
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
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
    if (!this.readOnlyProfile) return;
    try {
      await proveNeo4jAgentPrincipal(this.client(), { database: this.database(), timeoutMs: this.queryTimeout });
    } catch (error) {
      await this.disconnect().catch((closeError: unknown) => this.logError("connect cleanup", closeError));
      const refused = this.providerFailure(error);
      this.setError(refused);
      throw refused;
    }
  }

  // ==========================================================================
  // Agent read-only profile
  // ==========================================================================

  /** One agent statement (see the file comment). */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    const client = this.client();
    if (!this.readOnlyProfile) {
      throw new RefusedBeforeSendError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        this.type,
        statement,
      );
    }
    assertReadOnlyBudget(budget, this.type);
    if (mode !== "execute") {
      throw new RefusedBeforeSendError("Neo4j composes no estimating plan for the agent", this.type, statement);
    }
    const reading = readNeo4jAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, this.type, statement);
    const database = this.database();
    const signal = AbortSignal.timeout(budget.statementTimeoutMs);
    return this.trackQuery(async () => {
      try {
        await proveNeo4jAgentPrincipal(client, { database, timeoutMs: budget.statementTimeoutMs, signal });
      } catch (error) {
        throw this.providerFailure(error);
      }
      // One row past the budget is read, so a result the budget cannot hold is known to be one.
      const { result, executionTime } = await this.runVerdict(reading.verdict, {
        database,
        timeoutMs: budget.statementTimeoutMs,
        maxRows: budget.maxResultRows,
        signal,
      });
      if (result.truncated) {
        const atLeast = budget.maxResultRows + 1;
        throw new QueryError(
          `${rowBudgetSentence(atLeast, budget.maxResultRows)}; the read stops one row past the budget, so at least ${atLeast} rows match and the total is not known: narrow the statement`,
          this.type,
          statement,
        );
      }
      const bytes = measureResultBytes([...result.rows]);
      if (bytes > budget.maxResultBytes) {
        throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), this.type, statement);
      }
      return toQueryResult(result, executionTime);
    });
  }

  /** A refusal of the proof is itself; a transport failure goes through the error table. */
  private providerFailure(error: unknown): Error {
    if (error instanceof ExecutionProfileError) return error;
    return error instanceof GraphClientError ? this.profile.mapError(error) : (error as Error);
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
