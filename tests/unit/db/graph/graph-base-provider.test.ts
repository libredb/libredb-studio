/**
 * The provider half every graph engine shares (Neo4j provider spec 4, 5.1, 5.4, 5.5; revisions
 * SR4, SR10, SR15, SR16, SR17).
 *
 * A `TestGraphProvider` supplies a profile built from Neo4j-like policy lists, a fake catalog
 * and a fake statement gate, and a `GraphClientFactory` whose scripted client records every
 * call. Nothing here opens a socket: the tests pin the order of the query pipeline (policy,
 * gate, one READ run), the result shape, cancellation through the run's signal, the single
 * container, the shared and expiring catalog cache, and the read-only refusals.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type {
  BoltClientConfig,
  GraphClient,
  GraphClientFactory,
  GraphRunOptions,
  GraphRunResult,
  GraphServerInfo,
  GraphTransport,
} from "@/lib/db/graph/bolt/client";
import { GraphClientError } from "@/lib/db/graph/bolt/client";
import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";
import type { CypherReadVerdict, CypherRefusal } from "@/lib/db/graph/cypher/read-policy";
import {
  type GraphCatalog,
  type GraphEngineProfile,
  GraphBaseProvider,
  type GraphStatementGate,
} from "@/lib/db/graph/graph-base-provider";
import type { GraphCatalogEntry, GraphIndexRow, GraphKindId, GraphPropertyRow } from "@/lib/db/graph/objects";
import { DatabaseConfigError, DatabaseError, QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  ActiveSessionDetails,
  DatabaseConnection,
  DatabaseOverview,
  DatabaseType,
  IndexStats,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

// The type-id joins the union in the registration task; until then it is spelled through string.
const GRAPH_TYPE = "neo4j" as string as DatabaseType;

const SERVER: GraphServerInfo = { address: "db.example:7687", agent: "Neo4j/5.26.0", protocolVersion: "5.8" };

const NODE = { "~graph": "node", elementId: "4:x:0", labels: ["Service"], properties: { name: "api" } };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RunCall {
  readonly statement: string;
  readonly options: GraphRunOptions;
}

/** One scripted client per factory call; every call is recorded on the script. */
class FakeTransport {
  readonly configs: BoltClientConfig[] = [];
  readonly calls: RunCall[] = [];
  closes = 0;
  verifies = 0;
  verify: () => Promise<GraphServerInfo> = async () => SERVER;
  run: (statement: string, options: GraphRunOptions) => Promise<GraphRunResult> = async () => ({
    fields: ["n"],
    rows: [{ n: 1 }],
    truncated: false,
  });
  closeError: unknown;

  readonly factory: GraphClientFactory = (config) => {
    this.configs.push(config);
    const client: GraphClient = {
      verify: () => {
        this.verifies++;
        return this.verify();
      },
      run: (statement, options) => {
        this.calls.push({ statement, options });
        return this.run(statement, options);
      },
      close: async () => {
        this.closes++;
        if (this.closeError !== undefined) throw this.closeError;
      },
    };
    return client;
  };
}

type ListAnswer = { entries: readonly GraphCatalogEntry[]; truncated: boolean };

const entries = (...names: string[]): GraphCatalogEntry[] => names.map((name) => ({ name }));

/** A catalog whose answers each test sets; it counts every read and remembers the database it was asked for. */
class FakeCatalog implements GraphCatalog {
  home = "graph";
  homeCalls = 0;
  homeError: unknown;
  readonly lists: Partial<Record<GraphKindId, ListAnswer | unknown>> = {
    label: { entries: entries("Service", "Team"), truncated: false },
    relationship_type: { entries: entries("OWNS"), truncated: false },
    index: { entries: entries("service_name"), truncated: false },
    constraint: { entries: [], truncated: false },
  };
  readonly listCalls: [string, GraphKindId][] = [];
  properties: () => Promise<{ rows: readonly GraphPropertyRow[]; truncated: boolean }> = async () => ({
    rows: [
      { owner: "Service", property: "name", types: ["String"], mandatory: true },
      { owner: "Team", property: "size", types: ["Long"], mandatory: false },
      { owner: "OWNS", property: "since", types: ["Date"], mandatory: false },
    ],
    truncated: false,
  });
  readonly propertyCalls: [string, string][] = [];
  indexes: () => Promise<{ rows: readonly GraphIndexRow[]; truncated: boolean }> = async () => ({
    rows: [
      {
        name: "service_name",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Service"],
        properties: ["name"],
        unique: true,
      },
      { name: "owns_since", type: "RANGE", entityType: "RELATIONSHIP", labelsOrTypes: ["OWNS"], properties: ["since"] },
    ],
    truncated: false,
  });
  readonly indexCalls: string[] = [];

  async homeDatabase(): Promise<string> {
    this.homeCalls++;
    if (this.homeError !== undefined) throw this.homeError;
    return this.home;
  }

  async listKind(_client: Pick<GraphClient, "run">, database: string, kind: GraphKindId): Promise<ListAnswer> {
    this.listCalls.push([database, kind]);
    const answer = this.lists[kind];
    if (answer instanceof Error) throw answer;
    return answer as ListAnswer;
  }

  propertyRows(_client: Pick<GraphClient, "run">, database: string, kind: "label" | "relationship_type") {
    this.propertyCalls.push([database, kind]);
    return this.properties();
  }

  indexRows(_client: Pick<GraphClient, "run">, database: string) {
    this.indexCalls.push(database);
    return this.indexes();
  }
}

const POLICY = {
  deniedWords: [["CREATE"], ["MERGE"], ["SET"], ["DELETE"], ["DETACH"], ["REMOVE"], ["DROP"], ["IN", "TRANSACTIONS"]],
  deniedNamespaces: ["apoc.", "gds."],
  allowedProcedures: ["db.labels", "db.relationshipTypes"],
  allowedQualifiedFunctions: ["date.truncate"],
  allowedShowForms: [["INDEXES"], ["CONSTRAINTS"], ["DATABASES"]],
  refusedPrefixes: ["EXPLAIN", "PROFILE"] as const,
};

/** Maps every transport failure to one recognisable repository error. */
const mapError = (error: GraphClientError) => new DatabaseError(`TestGraph says: ${error.message}`);

function profileWith(catalog: FakeCatalog, statementGate?: GraphStatementGate): GraphEngineProfile {
  return {
    engineLabel: "TestGraph",
    readPolicy: POLICY,
    dialect: { supportsVersionPrefix: true, offsetKeyword: "SKIP" },
    defaultPort: 7687,
    catalog,
    mapError,
    ...(statementGate === undefined ? {} : { statementGate }),
  };
}

class TestGraphProvider extends GraphBaseProvider {
  /** Set by the cache-expiry test; unset, the base class's own clock answers. */
  clock: number | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions,
    profile: GraphEngineProfile,
    createClient: GraphClientFactory,
    endpointOf: GraphTransport["endpointOf"] = boltEndpointOf,
  ) {
    super(config, options, profile, { endpointOf, createClient });
  }

  public getCapabilities(): ProviderCapabilities {
    return { queryLanguage: "json" } as ProviderCapabilities;
  }
  public getLabels(): ProviderLabels {
    return {} as ProviderLabels;
  }
  public async getOverview(): Promise<DatabaseOverview> {
    return {} as DatabaseOverview;
  }
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return {};
  }
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }
  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }
  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }
  public async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  protected override now(): number {
    return this.clock ?? super.now();
  }

  public exposedClient(): GraphClient {
    return this.client();
  }
  public exposedDatabase(): string | undefined {
    return this.currentDatabase();
  }
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "graph",
    type: GRAPH_TYPE,
    host: "db.example",
    port: 7687,
    user: "reader",
    password: "secret",
    database: "movies",
    createdAt: new Date(0),
    ...overrides,
  };
}

interface Setup {
  readonly provider: TestGraphProvider;
  readonly transport: FakeTransport;
  readonly catalog: FakeCatalog;
}

function setup(
  options: { config?: Partial<DatabaseConnection>; gate?: GraphStatementGate; providerOptions?: ProviderOptions } = {},
): Setup {
  const transport = new FakeTransport();
  const catalog = new FakeCatalog();
  const provider = new TestGraphProvider(
    connection(options.config),
    options.providerOptions ?? {},
    profileWith(catalog, options.gate),
    transport.factory,
  );
  return { provider, transport, catalog };
}

async function connected(options: Parameters<typeof setup>[0] = {}): Promise<Setup> {
  const made = setup(options);
  await made.provider.connect();
  return made;
}

/** A promise and the function that settles it, for a run the test holds open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const CONTAINER = ["movies"] as const;

// ---------------------------------------------------------------------------
// Construction and connection
// ---------------------------------------------------------------------------

describe("construction", () => {
  test("validates nothing and opens nothing", () => {
    const { provider, transport, catalog } = setup({ config: { host: "user@bad" } });
    expect(transport.configs).toEqual([]);
    expect(catalog.homeCalls).toBe(0);
    expect(provider.isConnected()).toBe(false);
  });

  test("connects through the transport it is handed: its endpoint and its client", async () => {
    const transport = new FakeTransport();
    const endpoints: Array<[string | undefined, number]> = [];
    const provider = new TestGraphProvider(
      connection(),
      {},
      profileWith(new FakeCatalog()),
      transport.factory,
      (config, port) => {
        endpoints.push([config.host, port]);
        return { uri: "test://elsewhere:1" };
      },
    );
    await provider.connect();
    expect(endpoints).toEqual([["db.example", 7687]]);
    expect(transport.configs.map((config) => config.uri)).toEqual(["test://elsewhere:1"]);
  });

  test("every surface refuses before connect", async () => {
    const { provider } = setup();
    expect(() => provider.exposedClient()).toThrow(DatabaseConfigError);
    expect(provider.exposedDatabase()).toBeUndefined();
    expect(await rejectionOf(provider.query("MATCH (n) RETURN n"))).toBeInstanceOf(DatabaseConfigError);
    expect(await rejectionOf(provider.listContainers())).toBeInstanceOf(DatabaseConfigError);
    expect(await rejectionOf(provider.getHealth())).toBeInstanceOf(DatabaseConfigError);
  });
});

describe("connect", () => {
  test("builds the Bolt client from the panel, verifies, and keeps the configured database", async () => {
    const { provider, transport, catalog } = await connected({ providerOptions: { queryTimeout: 5000 } });
    expect(transport.configs).toEqual([
      {
        uri: "bolt://db.example:7687",
        user: "reader",
        password: "secret",
        connectionTimeoutMs: 5000,
        userAgent: "libredb-studio",
      },
    ]);
    expect(transport.verifies).toBe(1);
    expect(catalog.homeCalls).toBe(0);
    expect(provider.isConnected()).toBe(true);
    expect(provider.exposedDatabase()).toBe("movies");
  });

  test("hands a custom CA to the client and uses the profile's port when the panel has none", async () => {
    const { transport } = await connected({
      config: { port: undefined, ssl: { mode: "verify-ca", caCert: "-----BEGIN CERTIFICATE-----" } },
    });
    expect(transport.configs[0]?.uri).toBe("bolt+s://db.example:7687");
    expect(transport.configs[0]?.trustedCertificatePem).toBe("-----BEGIN CERTIFICATE-----");
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
  ])(
    "resolves the home database through the catalog when the connection's database is %s (SR4)",
    async (_name, database) => {
      const { provider, catalog } = await connected({ config: { database } });
      expect(catalog.homeCalls).toBe(1);
      expect(provider.exposedDatabase()).toBe("graph");
    },
  );

  test("a refused verify closes the client and throws the profile's mapped error", async () => {
    const made = setup();
    made.transport.verify = async () => {
      throw new GraphClientError("auth", "bad credentials");
    };
    const error = await rejectionOf(made.provider.connect());
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as Error).message).toBe("TestGraph says: bad credentials");
    expect(made.transport.closes).toBe(1);
    expect(made.provider.isConnected()).toBe(false);
  });

  test("a failed home-database read closes the client too", async () => {
    const made = setup({ config: { database: undefined } });
    made.catalog.homeError = new GraphClientError("query", "no home");
    expect(((await rejectionOf(made.provider.connect())) as Error).message).toBe("TestGraph says: no home");
    expect(made.transport.closes).toBe(1);
  });

  test("an error that is not the transport's surfaces as itself, and a failing close is logged, not thrown", async () => {
    const made = setup();
    const defect = new TypeError("defect");
    made.transport.verify = async () => {
      throw defect;
    };
    made.transport.closeError = new Error("close failed");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await rejectionOf(made.provider.connect())).toBe(defect);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("connect cleanup failed: close failed");
    } finally {
      logged.mockRestore();
    }
  });

  test("an endpoint the panel cannot address is refused before any client exists", async () => {
    const made = setup({ config: { host: "user@db.example" } });
    expect(await rejectionOf(made.provider.connect())).toBeInstanceOf(DatabaseConfigError);
    expect(made.transport.configs).toEqual([]);
  });

  test("disconnect aborts every statement in flight, closes the client and clears the state", async () => {
    const { provider, transport } = await connected();
    const held = deferred<GraphRunResult>();
    transport.run = () => held.promise;
    const running = provider.query("MATCH (n) RETURN n", [], "q1");
    await Promise.resolve();
    await provider.disconnect();
    expect(transport.calls[0]?.options.signal?.aborted).toBe(true);
    expect(transport.closes).toBe(1);
    expect(provider.isConnected()).toBe(false);
    expect(provider.exposedDatabase()).toBeUndefined();
    expect(await provider.cancelQuery("q1")).toBe(false);
    held.resolve({ fields: [], rows: [], truncated: false });
    await running;
  });

  test("connecting again closes the previous client and aborts its statements first", async () => {
    const { provider, transport } = await connected();
    const held = deferred<GraphRunResult>();
    transport.run = () => held.promise;
    const running = provider.query("MATCH (n) RETURN n", [], "q1");
    await Promise.resolve();
    await provider.connect();
    expect(transport.configs).toHaveLength(2);
    expect(transport.closes).toBe(1);
    expect(transport.calls[0]?.options.signal?.aborted).toBe(true);
    expect(await provider.cancelQuery("q1")).toBe(false);
    expect(provider.isConnected()).toBe(true);
    held.resolve({ fields: [], rows: [], truncated: false });
    await running;
  });

  test("a failed reconnect leaves no stale session behind", async () => {
    const { provider, transport } = await connected();
    transport.verify = async () => {
      throw new GraphClientError("connection", "unreachable");
    };
    expect(((await rejectionOf(provider.connect())) as Error).message).toBe("TestGraph says: unreachable");
    expect(transport.closes).toBe(2);
    expect(provider.isConnected()).toBe(false);
    expect(provider.exposedDatabase()).toBeUndefined();
    expect(() => provider.exposedClient()).toThrow(DatabaseConfigError);
  });

  test("a previous client that fails to close is logged, and the reconnect goes on", async () => {
    const { provider, transport } = await connected();
    transport.closeError = new Error("close failed");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("reconnect cleanup failed: close failed");
    } finally {
      logged.mockRestore();
    }
  });

  test("disconnect before connect closes nothing", async () => {
    const { provider, transport } = setup();
    await provider.disconnect();
    expect(transport.closes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Query pipeline
// ---------------------------------------------------------------------------

describe("query", () => {
  test("refuses bound parameters and accepts an empty list", async () => {
    const { provider, transport } = await connected();
    const error = await rejectionOf(provider.query("MATCH (n) RETURN n", [1]));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe("Parameters are not supported for TestGraph in this version.");
    expect(transport.calls).toEqual([]);
    await provider.query("MATCH (n) RETURN n", []);
    expect(transport.calls).toHaveLength(1);
  });

  test("a statement the policy refuses makes no run and carries the refusal's sentence and position", async () => {
    const { provider, transport } = await connected();
    const error = await rejectionOf(provider.query("MATCH (n) CREATE (m)"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("CREATE");
    expect((error as QueryError).position).toBe(10);
    expect(transport.calls).toEqual([]);
  });

  test("runs the policy's statement once in a READ run on the connection's database", async () => {
    const { provider, transport } = await connected({ providerOptions: { queryTimeout: 4000 } });
    const result = await provider.query("  MATCH (n) RETURN n.name AS name;  ");
    expect(transport.calls).toHaveLength(1);
    const [call] = transport.calls;
    expect(call?.statement).toBe("MATCH (n) RETURN n.name AS name");
    expect(call?.options).toEqual({
      database: "movies",
      timeoutMs: 4000,
      maxRows: DEFAULT_QUERY_LIMIT,
      signal: call?.options.signal,
      metadata: { app: "libredb-studio" },
    });
    expect(call?.options.signal).toBeInstanceOf(AbortSignal);
    expect(result.fields).toEqual(["n"]);
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(typeof result.executionTime).toBe("number");
    expect(result).not.toHaveProperty("pagination");
    expect(result).not.toHaveProperty("columnTypes");
    expect(result).not.toHaveProperty("warnings");
  });

  test("runs on the resolved home database when the connection names none", async () => {
    const { provider, transport } = await connected({ config: { database: undefined } });
    await provider.query("MATCH (n) RETURN n");
    expect(transport.calls[0]?.options.database).toBe("graph");
  });

  test("a cut result is limited, and graph columns are typed while scalar ones are not", async () => {
    const { provider, transport } = await connected();
    const proto = Object.defineProperty({ k: 1, n: NODE }, "__proto__", { value: NODE, enumerable: true });
    transport.run = async () => ({
      fields: ["k", "n", "__proto__"],
      rows: [proto],
      truncated: true,
      warnings: ["Column n: value too large"],
    });
    const result = await provider.query("MATCH (n) RETURN 1 AS k, n, n AS `__proto__`");
    expect(result.pagination).toEqual({
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
      hasMore: true,
      totalReturned: 1,
      wasLimited: true,
    });
    expect(result.columnTypes).toEqual(
      Object.fromEntries([
        ["n", "Node"],
        ["__proto__", "Node"],
      ]),
    );
    expect(Object.hasOwn(result.columnTypes ?? {}, "__proto__")).toBe(true);
    expect(result.warnings).toEqual([{ message: "Column n: value too large" }]);
  });

  test("an empty warning list adds no warnings field", async () => {
    const { provider, transport } = await connected();
    transport.run = async () => ({ fields: [], rows: [], truncated: false, warnings: [] });
    expect(await provider.query("MATCH (n) RETURN n")).not.toHaveProperty("warnings");
  });

  test("a transport failure maps through the profile", async () => {
    const { provider, transport } = await connected();
    transport.run = async () => {
      throw new GraphClientError("syntax", "Invalid input");
    };
    expect(((await rejectionOf(provider.query("MATCH (n) RETURN n"))) as Error).message).toBe(
      "TestGraph says: Invalid input",
    );
  });
});

describe("statement gate (SR10)", () => {
  function recordingGate(answer: () => Promise<CypherRefusal | undefined>) {
    const seen: { verdict: Extract<CypherReadVerdict, { allowed: true }>; options: GraphRunOptions }[] = [];
    const gate: GraphStatementGate = (_client, verdict, options) => {
      seen.push({ verdict, options });
      return answer();
    };
    return { gate, seen };
  }

  const refusal: CypherRefusal = {
    code: "server-classification",
    subject: "w",
    message: "The server classifies this statement as a write.",
  };

  test("is asked before the run with the run's options, and a pass runs once", async () => {
    const { gate, seen } = recordingGate(async () => undefined);
    const { provider, transport } = await connected({ gate });
    await provider.query("CALL db.labels()");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict.callsProcedure).toBe(true);
    expect(seen[0]?.options).toBe(transport.calls[0]?.options as GraphRunOptions);
    expect(transport.calls).toHaveLength(1);
  });

  test("a refusal throws its sentence and makes no run", async () => {
    const { gate } = recordingGate(async () => refusal);
    const { provider, transport } = await connected({ gate });
    const error = await rejectionOf(provider.query("MATCH (n) RETURN n"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(refusal.message);
    expect(transport.calls).toEqual([]);
  });

  test("is skipped for an allowed SHOW form", async () => {
    const { gate, seen } = recordingGate(async () => refusal);
    const { provider, transport } = await connected({ gate });
    await provider.query("SHOW INDEXES");
    expect(seen).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });

  test("an error while checking refuses the statement, worded with the mapped message", async () => {
    const { gate } = recordingGate(async () => {
      throw new GraphClientError("query", "EXPLAIN failed");
    });
    const { provider, transport } = await connected({ gate });
    const error = await rejectionOf(provider.query("MATCH (n) RETURN n"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "The statement could not be checked by the server, so it was not run: TestGraph says: EXPLAIN failed",
    );
    expect(transport.calls).toEqual([]);
  });

  test("a value that is not an Error is worded as text", async () => {
    const { gate } = recordingGate(() => Promise.reject("socket closed"));
    const { provider } = await connected({ gate });
    expect(((await rejectionOf(provider.query("MATCH (n) RETURN n"))) as Error).message).toBe(
      "The statement could not be checked by the server, so it was not run: socket closed",
    );
  });

  test("a cancel during the check reports the cancellation, not a refused check", async () => {
    const held = deferred<CypherRefusal | undefined>();
    const { gate } = recordingGate(() => held.promise);
    const { provider, transport } = await connected({ gate });
    const running = provider.query("MATCH (n) RETURN n", undefined, "q1");
    await Promise.resolve();
    expect(await provider.cancelQuery("q1")).toBe(true);
    held.reject(new GraphClientError("cancelled", "The query was cancelled"));
    expect(((await rejectionOf(running)) as Error).message).toBe("TestGraph says: The query was cancelled");
    expect(transport.calls).toEqual([]);
  });
});

describe("cancelQuery", () => {
  test("aborts the signal the run saw and answers true; an unknown or finished id answers false", async () => {
    const { provider, transport } = await connected();
    const held = deferred<GraphRunResult>();
    transport.run = (_statement, options) => {
      options.signal?.addEventListener("abort", () =>
        held.reject(new GraphClientError("cancelled", "The query was cancelled")),
      );
      return held.promise;
    };
    const running = provider.query("MATCH (n) RETURN n", undefined, "q1");
    await Promise.resolve();
    expect(await provider.cancelQuery("other")).toBe(false);
    expect(await provider.cancelQuery("q1")).toBe(true);
    expect(transport.calls[0]?.options.signal?.aborted).toBe(true);
    expect(((await rejectionOf(running)) as Error).message).toBe("TestGraph says: The query was cancelled");
    expect(await provider.cancelQuery("q1")).toBe(false);
  });

  test("every statement in flight under one id is cancelled, not only the latest", async () => {
    const { provider, transport } = await connected();
    const first = deferred<GraphRunResult>();
    const second = deferred<GraphRunResult>();
    const answers = [first.promise, second.promise];
    transport.run = () => answers.shift() as Promise<GraphRunResult>;
    const one = provider.query("MATCH (n) RETURN n", undefined, "q");
    const two = provider.query("MATCH (n) RETURN n", undefined, "q");
    await Promise.resolve();
    expect(await provider.cancelQuery("q")).toBe(true);
    expect(transport.calls[0]?.options.signal?.aborted).toBe(true);
    expect(transport.calls[1]?.options.signal?.aborted).toBe(true);
    first.resolve({ fields: [], rows: [], truncated: false });
    second.resolve({ fields: [], rows: [], truncated: false });
    await Promise.all([one, two]);
    expect(await provider.cancelQuery("q")).toBe(false);
  });

  test("a later statement under the same id is not removed by an earlier one finishing", async () => {
    const { provider, transport } = await connected();
    const first = deferred<GraphRunResult>();
    const second = deferred<GraphRunResult>();
    const answers = [first.promise, second.promise];
    transport.run = () => answers.shift() as Promise<GraphRunResult>;
    const one = provider.query("MATCH (n) RETURN n", undefined, "q");
    const two = provider.query("MATCH (n) RETURN n", undefined, "q");
    await Promise.resolve();
    first.resolve({ fields: [], rows: [], truncated: false });
    await one;
    expect(await provider.cancelQuery("q")).toBe(true);
    expect(transport.calls[1]?.options.signal?.aborted).toBe(true);
    second.resolve({ fields: [], rows: [], truncated: false });
    await two;
  });
});

test("prepareQuery is a pass-through with no limit added", async () => {
  const { provider } = setup();
  expect(provider.prepareQuery("MATCH (n) RETURN n")).toEqual({
    query: "MATCH (n) RETURN n",
    wasLimited: false,
    limit: DEFAULT_QUERY_LIMIT,
    offset: 0,
  });
});

// ---------------------------------------------------------------------------
// Object surface
// ---------------------------------------------------------------------------

describe("listContainers", () => {
  test("answers exactly the connection's database as the session default (SR4)", async () => {
    const { provider } = await connected();
    expect(await provider.listContainers()).toEqual([
      { path: ["movies"], name: "movies", level: 0, isSessionDefault: true },
    ]);
    expect(await provider.listContainers([])).toHaveLength(1);
  });

  test("a database has no child containers", async () => {
    const { provider } = await connected();
    expect(await provider.listContainers(["movies"])).toEqual([]);
  });

  test("starts the tree's refresh: the catalog cache is read again afterwards (SR17)", async () => {
    const { provider, catalog } = await connected();
    await provider.describeObject(["movies", "(:Service)"], "label");
    await provider.describeObject(["movies", "(:Service)"], "label");
    expect(catalog.propertyCalls).toHaveLength(1);
    await provider.listContainers();
    await provider.describeObject(["movies", "(:Service)"], "label");
    expect(catalog.propertyCalls).toHaveLength(2);
    expect(catalog.indexCalls).toHaveLength(2);
  });
});

describe("countObjects", () => {
  test("counts every kind from one listing each", async () => {
    const { provider, catalog } = await connected();
    expect(await provider.countObjects(CONTAINER)).toEqual({
      label: { count: 2 },
      relationship_type: { count: 1 },
      index: { count: 1 },
      constraint: { count: 0 },
    });
    expect(catalog.listCalls).toEqual([
      ["movies", "label"],
      ["movies", "relationship_type"],
      ["movies", "index"],
      ["movies", "constraint"],
    ]);
  });

  test("a listing cut at the catalog's bound is a sampled count (SR16), and a name listed twice counts once", async () => {
    const { provider, catalog } = await connected();
    catalog.lists.label = { entries: entries("A", "B", "A"), truncated: true };
    const counts = await provider.countObjects(CONTAINER);
    expect(counts.label).toEqual({ count: 2, sampledFrom: "one catalog read that stopped at its row bound" });
  });

  test("a refused read is the kind's unavailable sentence and never throws", async () => {
    const { provider, catalog } = await connected();
    catalog.lists.index = new GraphClientError("query", "permission denied");
    catalog.lists.constraint = new QueryError("unreadable answer");
    const counts = await provider.countObjects(CONTAINER);
    expect(counts.index).toEqual({ unavailable: "TestGraph says: permission denied" });
    expect(counts.constraint).toEqual({ unavailable: "unreadable answer" });
    expect(counts.label).toEqual({ count: 2 });
  });

  test("a defect is not a refused read", async () => {
    const { provider, catalog } = await connected();
    const defect = new TypeError("defect");
    catalog.lists.label = defect;
    expect(await rejectionOf(provider.countObjects(CONTAINER))).toBe(defect);
  });

  test("a container other than the connection's database is refused with no read", async () => {
    const { provider, catalog } = await connected();
    const errors = await Promise.all(
      [[], ["other"], ["movies", "x"]].map((container) => rejectionOf(provider.countObjects(container))),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toContain('"movies"');
    }
    expect(catalog.listCalls).toEqual([]);
  });
});

describe("listObjects", () => {
  test("maps the kind's listing onto kind-qualified paths (SR5)", async () => {
    const { provider } = await connected();
    expect(await provider.listObjects(CONTAINER, "relationship_type")).toEqual([
      { path: ["movies", "[:OWNS]"], name: "OWNS", kind: "relationship_type" },
    ]);
  });

  test("an unknown kind is refused", async () => {
    const { provider, catalog } = await connected();
    const error = await rejectionOf(provider.listObjects(CONTAINER, "table"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe('TestGraph has no object kind "table"');
    expect(catalog.listCalls).toEqual([]);
  });

  test("a refused listing maps through the profile", async () => {
    const { provider, catalog } = await connected();
    catalog.lists.label = new GraphClientError("query", "denied");
    expect(((await rejectionOf(provider.listObjects(CONTAINER, "label"))) as Error).message).toBe(
      "TestGraph says: denied",
    );
  });
});

describe("describeObject", () => {
  test("a label reads its columns and node indexes", async () => {
    const { provider, catalog } = await connected();
    expect(await provider.describeObject(["movies", "(:Service)"], "label")).toEqual({
      path: ["movies", "(:Service)"],
      columns: [{ name: "name", type: "String", nullable: false, isPrimary: false }],
      indexes: [{ name: "service_name", columns: ["name"], unique: true }],
      foreignKeys: [],
    });
    expect(catalog.propertyCalls).toEqual([["movies", "label"]]);
    expect(catalog.indexCalls).toEqual(["movies"]);
  });

  test("a relationship type reads its own property rows and relationship indexes", async () => {
    const { provider, catalog } = await connected();
    expect(await provider.describeObject(["movies", "[:OWNS]"], "relationship_type")).toEqual({
      path: ["movies", "[:OWNS]"],
      columns: [{ name: "since", type: "Date", nullable: true, isPrimary: false }],
      indexes: [{ name: "owns_since", columns: ["since"], unique: false }],
      foreignKeys: [],
    });
    expect(catalog.propertyCalls).toEqual([["movies", "relationship_type"]]);
  });

  test("an index or a constraint has no columns and reads nothing", async () => {
    const { provider, catalog } = await connected();
    expect(await provider.describeObject(["movies", "INDEX service_name"], "index")).toEqual({
      path: ["movies", "INDEX service_name"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect((await provider.describeObject(["movies", "CONSTRAINT c"], "constraint")).columns).toEqual([]);
    expect(catalog.propertyCalls).toEqual([]);
    expect(catalog.indexCalls).toEqual([]);
  });

  test("a segment of another kind, or no kind, is refused", async () => {
    const { provider } = await connected();
    const segments = ["[:OWNS]", "Service"];
    const errors = await Promise.all(
      segments.map((segment) => rejectionOf(provider.describeObject(["movies", segment], "label"))),
    );
    errors.forEach((error, at) => {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe(`${JSON.stringify(segments[at])} does not address a label`);
    });
    expect(await rejectionOf(provider.describeObject([], "label"))).toBeInstanceOf(QueryError);
  });

  test("refuses an object when a property or index read was cut, rather than answer too few columns (SR16)", async () => {
    const { provider, catalog } = await connected();
    const properties = catalog.properties;
    provider.clock = 0;
    catalog.properties = async () => ({ ...(await properties()), truncated: true });
    const error = await rejectionOf(provider.describeObject(["movies", "(:Service)"], "label"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      'The columns and indexes of "(:Service)" cannot be listed whole: the catalog\'s property read stopped at its row bound.',
    );
    catalog.properties = properties;
    catalog.indexes = async () => ({ rows: [], truncated: true });
    provider.clock = 1_000_000;
    expect(
      ((await rejectionOf(provider.describeObject(["movies", "[:OWNS]"], "relationship_type"))) as Error).message,
    ).toBe(
      'The columns and indexes of "[:OWNS]" cannot be listed whole: the catalog\'s index read stopped at its row bound.',
    );
  });

  test("concurrent describes share one read of each catalog call (SR17)", async () => {
    const { provider, catalog } = await connected();
    await Promise.all([
      provider.describeObject(["movies", "(:Service)"], "label"),
      provider.describeObject(["movies", "(:Team)"], "label"),
      provider.describeObject(["movies", "(:Service)"], "label"),
    ]);
    expect(catalog.propertyCalls).toHaveLength(1);
    expect(catalog.indexCalls).toHaveLength(1);
  });

  test("a rejected read is evicted and read again next time", async () => {
    const { provider, catalog } = await connected();
    const working = catalog.properties;
    catalog.properties = async () => {
      throw new GraphClientError("query", "busy");
    };
    expect(((await rejectionOf(provider.describeObject(["movies", "(:Service)"], "label"))) as Error).message).toBe(
      "TestGraph says: busy",
    );
    catalog.properties = working;
    expect((await provider.describeObject(["movies", "(:Service)"], "label")).columns).toHaveLength(1);
    expect(catalog.propertyCalls).toHaveLength(2);
    expect(catalog.indexCalls).toHaveLength(1);
  });

  test("a kept read is used for 60 seconds, then read again", async () => {
    const { provider, catalog } = await connected();
    provider.clock = 1_000;
    await provider.describeObject(["movies", "(:Service)"], "label");
    provider.clock = 60_999;
    await provider.describeObject(["movies", "(:Service)"], "label");
    expect(catalog.propertyCalls).toHaveLength(1);
    provider.clock = 61_000;
    await provider.describeObject(["movies", "(:Service)"], "label");
    expect(catalog.propertyCalls).toHaveLength(2);
    expect(catalog.indexCalls).toHaveLength(2);
  });
});

describe("describeObjects", () => {
  test("describes every object of the kind from one read of each catalog call", async () => {
    const { provider, catalog } = await connected();
    const batch = await provider.describeObjects(CONTAINER, "label");
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["movies", "(:Service)"],
      ["movies", "(:Team)"],
    ]);
    expect(batch.details[1]?.columns).toEqual([{ name: "size", type: "Long", nullable: true, isPrimary: false }]);
    expect(batch).not.toHaveProperty("truncated");
    expect(catalog.listCalls).toEqual([["movies", "label"]]);
    expect(catalog.propertyCalls).toHaveLength(1);
    expect(catalog.indexCalls).toHaveLength(1);
  });

  test("a limit that cuts the list reports the caller's bound", async () => {
    const { provider } = await connected();
    const batch = await provider.describeObjects(CONTAINER, "label", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated).toEqual({ limit: 1, reason: callerBoundTruncationReason(1) });
    expect(await provider.describeObjects(CONTAINER, "label", 2)).not.toHaveProperty("truncated");
  });

  test("a listing cut by the catalog is reported, joined with the caller's bound when both bit (SR16)", async () => {
    const { provider, catalog } = await connected();
    catalog.lists.label = { entries: entries("A", "B", "C"), truncated: true };
    expect((await provider.describeObjects(CONTAINER, "label")).truncated).toEqual({
      limit: 3,
      reason: "the catalog's listing stopped at its row bound",
    });
    expect((await provider.describeObjects(CONTAINER, "label", 2)).truncated).toEqual({
      limit: 2,
      reason: `${callerBoundTruncationReason(2)}; the catalog's listing stopped at its row bound`,
    });
  });

  test("a property or index read cut by the catalog is reported, never answered as fewer columns (SR16)", async () => {
    const { provider, catalog } = await connected();
    const properties = catalog.properties;
    const indexes = catalog.indexes;
    provider.clock = 0;
    catalog.properties = async () => ({ ...(await properties()), truncated: true });
    expect((await provider.describeObjects(CONTAINER, "label")).truncated).toEqual({
      limit: 2,
      reason: "the catalog's property read stopped at its row bound",
    });
    catalog.indexes = async () => ({ ...(await indexes()), truncated: true });
    catalog.lists.label = { entries: entries("Service", "Team"), truncated: true };
    provider.clock = 1_000_000;
    expect((await provider.describeObjects(CONTAINER, "label", 1)).truncated).toEqual({
      limit: 1,
      reason: `${callerBoundTruncationReason(1)}; the catalog's listing stopped at its row bound; the catalog's property read stopped at its row bound; the catalog's index read stopped at its row bound`,
    });
    catalog.properties = properties;
    provider.clock = 2_000_000;
    expect((await provider.describeObjects(CONTAINER, "relationship_type")).truncated).toEqual({
      limit: 1,
      reason: "the catalog's index read stopped at its row bound",
    });
  });

  test("index and constraint objects are described with no column read", async () => {
    const { provider, catalog } = await connected();
    const batch = await provider.describeObjects(CONTAINER, "index");
    expect(batch.details).toEqual([
      { path: ["movies", "INDEX service_name"], columns: [], indexes: [], foreignKeys: [] },
    ]);
    expect(catalog.propertyCalls).toEqual([]);
  });

  test("a refused listing maps through the profile", async () => {
    const { provider, catalog } = await connected();
    catalog.lists.label = new GraphClientError("query", "denied");
    expect(((await rejectionOf(provider.describeObjects(CONTAINER, "label"))) as Error).message).toBe(
      "TestGraph says: denied",
    );
  });
});

// ---------------------------------------------------------------------------
// Health and maintenance
// ---------------------------------------------------------------------------

describe("getHealth", () => {
  test("verifies the server and answers the engine hook's figures", async () => {
    const { provider, transport } = await connected();
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(transport.verifies).toBe(2);
  });

  test("a failed verify throws the mapped error", async () => {
    const { provider, transport } = await connected();
    transport.verify = async () => {
      throw new GraphClientError("connection", "unreachable");
    };
    expect(((await rejectionOf(provider.getHealth())) as Error).message).toBe("TestGraph says: unreachable");
  });
});

test("runMaintenance always refuses: the connection is read-only", async () => {
  const { provider } = await connected();
  const error = await rejectionOf(provider.runMaintenance("vacuum"));
  expect(error).toBeInstanceOf(QueryError);
  expect((error as Error).message).toBe(
    "TestGraph connections are read-only in this version: no maintenance operation runs.",
  );
});
