import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseError } from "@/lib/db/errors";
import type { MonitoringPanelAnswer, MonitoringPanelRequest } from "@libredb/provider-sdk/calls";
import { type PanelReads, readDeclaredPanels, readPanel } from "@/lib/db/engine-facets/monitoring";
import { MONITORING_PANELS, type MonitoringPanel, type MonitoringPanelOffer } from "@/lib/db/engine-facets/types";
import type {
  ActiveSessionDetails,
  DatabaseOverview,
  IndexStats,
  PerformanceMetrics,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";

const OVERVIEW: DatabaseOverview = {
  version: "test",
  uptime: "0",
  activeConnections: 0,
  maxConnections: 0,
  databaseSize: "0",
  databaseSizeBytes: 0,
  tableCount: 0,
  indexCount: 0,
};
const PERFORMANCE: PerformanceMetrics = { cacheHitRatio: 99 };
const SLOW: SlowQueryStats[] = [];
const SESSIONS: ActiveSessionDetails[] = [];
const TABLES: TableStats[] = [];
const INDEXES: IndexStats[] = [];
const STORAGE: StorageStats[] = [];

const METHOD: Readonly<Record<MonitoringPanel, keyof PanelReads>> = {
  overview: "getOverview",
  performance: "getPerformanceMetrics",
  slowQueries: "getSlowQueries",
  activeSessions: "getActiveSessions",
  tables: "getTableStats",
  indexes: "getIndexStats",
  storage: "getStorageStats",
};

/** Seven reads that answer at once and record each call with its arguments, by panel. */
function recordingReads(rejecting: Partial<Record<MonitoringPanel, unknown>> = {}) {
  const calls: { panel: MonitoringPanel; args: unknown[] }[] = [];
  const answer =
    <T>(panel: MonitoringPanel, value: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ panel, args });
      return Object.hasOwn(rejecting, panel) ? Promise.reject(rejecting[panel]) : Promise.resolve(value);
    };
  const reads: PanelReads = {
    getOverview: answer("overview", OVERVIEW),
    getPerformanceMetrics: answer("performance", PERFORMANCE),
    getSlowQueries: answer("slowQueries", SLOW),
    getActiveSessions: answer("activeSessions", SESSIONS),
    getTableStats: answer("tables", TABLES),
    getIndexStats: answer("indexes", INDEXES),
    getStorageStats: answer("storage", STORAGE),
  };
  return { reads, calls, called: () => calls.map(({ panel }) => panel) };
}

const offerOf = (offered: readonly MonitoringPanel[]): MonitoringPanelOffer =>
  Object.fromEntries(
    MONITORING_PANELS.map((panel) => [panel, offered.includes(panel) ? "offered" : "not-offered"]),
  ) as MonitoringPanelOffer;

const ALL = offerOf(MONITORING_PANELS);
const KAFKA_SHAPED = offerOf(["overview", "storage"]);
const NONE = offerOf([]);

/** The panel read `readDeclaredPanels` is handed: each request read through `readPanel` on `reads`. */
const through =
  (reads: PanelReads) =>
  (request: MonitoringPanelRequest): Promise<MonitoringPanelAnswer> =>
    readPanel(reads, request);

/** A mapping that marks what it was handed, so a test can tell a mapped error from the raw one. */
const mapError = (error: Error): Error => new DatabaseError(`mapped: ${error.message}`);

describe("readDeclaredPanels", () => {
  test("reads every requested panel of an engine that offers all seven and lists none as not offered", async () => {
    const { reads, called } = recordingReads();
    const data = await readDeclaredPanels(through(reads), ALL, {}, mapError);
    expect(called()).toEqual([...MONITORING_PANELS]);
    expect(data.timestamp).toBeInstanceOf(Date);
    expect(data).toMatchObject({
      overview: OVERVIEW,
      performance: PERFORMANCE,
      slowQueries: SLOW,
      activeSessions: SESSIONS,
      tables: TABLES,
      indexes: INDEXES,
      storage: STORAGE,
      notOffered: [],
    });
    expect(data.errors).toBeUndefined();
  });

  test("never calls the read of a panel the engine does not offer, and lists it in notOffered", async () => {
    const { reads, called } = recordingReads();
    const data = await readDeclaredPanels(through(reads), KAFKA_SHAPED, {}, mapError);
    expect(called()).toEqual(["overview", "storage"]);
    expect(data.notOffered).toEqual(["performance", "slowQueries", "activeSessions", "tables", "indexes"]);
    expect(Object.keys(data).sort()).toEqual(["notOffered", "overview", "storage", "timestamp"]);
  });

  test("lists a panel the engine does not offer whether or not the caller requested it", async () => {
    const { reads, called } = recordingReads();
    const data = await readDeclaredPanels(
      through(reads),
      KAFKA_SHAPED,
      { includeTables: false, includeIndexes: false, includeStorage: false },
      mapError,
    );
    expect(called()).toEqual(["overview"]);
    expect(data.notOffered).toEqual(["performance", "slowQueries", "activeSessions", "tables", "indexes"]);
    expect(data.storage).toBeUndefined();
  });

  test("leaves an offered panel the caller did not request absent, unlisted and without an errors entry", async () => {
    const { reads, called } = recordingReads();
    const data = await readDeclaredPanels(
      through(reads),
      ALL,
      { includeTables: false, includeStorage: false },
      mapError,
    );
    expect(called()).toEqual(["overview", "performance", "slowQueries", "activeSessions", "indexes"]);
    expect(data.tables).toBeUndefined();
    expect(data.storage).toBeUndefined();
    expect(data.notOffered).toEqual([]);
    expect(data.errors).toBeUndefined();
  });

  test("records a rejected read under errors with the engine's own sentence and keeps the panels that answered", async () => {
    const starrocks = "Getting analyzing error. Detail message: Unknown table 'information_schema.PROCESSLIST'.";
    const { reads } = recordingReads({ activeSessions: new Error(starrocks) });
    const data = await readDeclaredPanels(through(reads), ALL, {}, mapError);
    expect(data.activeSessions).toBeUndefined();
    expect(data.errors).toEqual({ activeSessions: starrocks });
    expect(data.overview).toBe(OVERVIEW);
    expect(data.storage).toBe(STORAGE);
  });

  test("rejects with the first rejection as raised when every panel it read rejected with one sentence", async () => {
    const refused = new AuthenticationError("Authentication failed: password authentication failed", "postgres");
    const again = new AuthenticationError("Authentication failed: password authentication failed", "postgres");
    const rejecting = Object.fromEntries(
      MONITORING_PANELS.map((panel) => [panel, panel === "overview" ? refused : again]),
    );
    const { reads } = recordingReads(rejecting);
    let thrown: unknown;
    try {
      await readDeclaredPanels(through(reads), ALL, {}, mapError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(refused);
  });

  test("rejects through the provider's error mapping with the distinct sentences in panel order when every panel it read rejected with several", async () => {
    const lost = new Error("connection lost");
    const { reads } = recordingReads({
      overview: lost,
      performance: lost,
      slowQueries: new Error("no slow log"),
      activeSessions: new Error("no sessions"),
      tables: lost,
      indexes: lost,
      storage: new Error("no storage"),
    });
    let thrown: unknown;
    try {
      await readDeclaredPanels(through(reads), ALL, {}, mapError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseError);
    expect((thrown as Error).message).toBe("mapped: connection lost; no slow log; no sessions; no storage");
  });

  test("answers a partial payload when the core reads reject and a table read answers", async () => {
    const lost = new Error("connection lost");
    const { reads } = recordingReads({
      overview: lost,
      performance: lost,
      slowQueries: lost,
      activeSessions: lost,
      indexes: lost,
      storage: lost,
    });
    const data = await readDeclaredPanels(through(reads), ALL, {}, mapError);
    expect(data.tables).toBe(TABLES);
    expect(Object.keys(data.errors ?? {})).toEqual([
      "overview",
      "performance",
      "slowQueries",
      "activeSessions",
      "indexes",
      "storage",
    ]);
  });

  test("an engine offering the overview and storage fails when both reads reject and answers partly when one does", async () => {
    const both = recordingReads({ overview: new Error("broker down"), storage: new Error("broker down") });
    let thrown: unknown;
    try {
      await readDeclaredPanels(through(both.reads), KAFKA_SHAPED, {}, mapError);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("broker down");

    const one = recordingReads({ overview: new Error("not authorized to describe the cluster") });
    const data = await readDeclaredPanels(through(one.reads), KAFKA_SHAPED, {}, mapError);
    expect(data.overview).toBeUndefined();
    expect(data.storage).toBe(STORAGE);
    expect(data.errors).toEqual({ overview: "not authorized to describe the cluster" });
  });

  test("an engine that offers no panel reads nothing, lists every panel as not offered and does not reject", async () => {
    const { reads, called } = recordingReads(
      Object.fromEntries(MONITORING_PANELS.map((panel) => [panel, new Error("must not be read")])),
    );
    const data = await readDeclaredPanels(through(reads), NONE, {}, mapError);
    expect(called()).toEqual([]);
    expect(Object.keys(data).sort()).toEqual(["notOffered", "timestamp"]);
    expect(data.notOffered).toEqual([...MONITORING_PANELS]);
  });

  test("hands the slow-query and session limits and the schema filter to the reads that take them", async () => {
    const defaults = recordingReads();
    await readDeclaredPanels(through(defaults.reads), ALL, {}, mapError);
    const argsOf = (calls: typeof defaults.calls) =>
      Object.fromEntries(calls.map(({ panel, args }) => [METHOD[panel], args]));
    expect(argsOf(defaults.calls)).toEqual({
      getOverview: [],
      getPerformanceMetrics: [],
      getSlowQueries: [{ limit: 10 }],
      getActiveSessions: [{ limit: 50 }],
      getTableStats: [{ schema: undefined }],
      getIndexStats: [{ schema: undefined }],
      getStorageStats: [],
    });

    const given = recordingReads();
    await readDeclaredPanels(
      through(given.reads),
      ALL,
      { slowQueryLimit: 5, sessionLimit: 25, schemaFilter: "sales" },
      mapError,
    );
    expect(argsOf(given.calls)).toMatchObject({
      getSlowQueries: [{ limit: 5 }],
      getActiveSessions: [{ limit: 25 }],
      getTableStats: [{ schema: "sales" }],
      getIndexStats: [{ schema: "sales" }],
    });
  });

  test("records a rejection reason that is not an Error as its text", async () => {
    const { reads } = recordingReads({ slowQueries: "slow log unavailable" });
    const data = await readDeclaredPanels(through(reads), ALL, {}, mapError);
    expect(data.slowQueries).toBeUndefined();
    expect(data.errors).toEqual({ slowQueries: "slow log unavailable" });
  });
});

/** A panel read that records each request it is handed and answers it through `readPanel` on fresh doubles. */
function recordingRequests() {
  const requests: MonitoringPanelRequest[] = [];
  const { reads } = recordingReads();
  const read = (request: MonitoringPanelRequest): Promise<MonitoringPanelAnswer> => {
    requests.push(request);
    return readPanel(reads, request);
  };
  return { read, requests };
}

/** The sentence a panel answers when its read answered a form other than its own. */
const wrongForm = (panel: MonitoringPanel) =>
  `The ${panel} panel read answered a form other than the ${panel} panel's, which is a defect of the session that answered it.`;

describe("the panel requests readDeclaredPanels reads through", () => {
  test("each panel is read through one request of its own, the limits resolved and the schema present only when the caller named one", async () => {
    const defaults = recordingRequests();
    const options = {};
    await readDeclaredPanels(defaults.read, ALL, options, mapError);
    expect(defaults.requests).toEqual([
      { panel: "overview" },
      { panel: "performance" },
      { panel: "slowQueries", limit: 10 },
      { panel: "activeSessions", limit: 50 },
      { panel: "tables" },
      { panel: "indexes" },
      { panel: "storage" },
    ]);
    expect(defaults.requests.filter((request) => Object.hasOwn(request, "schema"))).toEqual([]);
    expect(new Set(defaults.requests).size).toBe(MONITORING_PANELS.length);
    expect(defaults.requests).not.toContain(options);

    const schema = crypto.randomUUID();
    const given = recordingRequests();
    await readDeclaredPanels(given.read, ALL, { slowQueryLimit: 7, sessionLimit: 13, schemaFilter: schema }, mapError);
    expect(given.requests).toEqual([
      { panel: "overview" },
      { panel: "performance" },
      { panel: "slowQueries", limit: 7 },
      { panel: "activeSessions", limit: 13 },
      { panel: "tables", schema },
      { panel: "indexes", schema },
      { panel: "storage" },
    ]);
    expect(new Set(given.requests).size).toBe(MONITORING_PANELS.length);
  });

  test("an answer whose form is not the requested panel's fails that panel by name, and the others answer", async () => {
    const accessor = Object.defineProperty({}, "performance", { get: () => PERFORMANCE, enumerable: true });
    const forms: readonly unknown[] = [
      {},
      { performance: PERFORMANCE, overview: OVERVIEW },
      { overview: OVERVIEW },
      accessor,
      null,
    ];
    await Promise.all(
      forms.map(async (form) => {
        const { reads } = recordingReads();
        const read = (request: MonitoringPanelRequest): Promise<MonitoringPanelAnswer> =>
          request.panel === "performance" ? Promise.resolve(form as MonitoringPanelAnswer) : readPanel(reads, request);
        const data = await readDeclaredPanels(read, ALL, {}, mapError);
        expect(data.performance).toBeUndefined();
        expect(data.errors).toEqual({ performance: wrongForm("performance") });
        expect(data.overview).toBe(OVERVIEW);
        expect(data.storage).toBe(STORAGE);
      }),
    );
  });

  test("a dashboard whose one panel answered a form other than its own rejects with that panel's sentence as a plain Error", async () => {
    const read = (): Promise<MonitoringPanelAnswer> => Promise.resolve({ storage: STORAGE });
    let thrown: unknown;
    try {
      await readDeclaredPanels(read, offerOf(["overview"]), {}, mapError);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).constructor).toBe(Error);
    expect((thrown as Error).message).toBe(wrongForm("overview"));
  });
});

describe("readPanel", () => {
  const REQUESTS: readonly MonitoringPanelRequest[] = [
    { panel: "overview" },
    { panel: "performance" },
    { panel: "slowQueries", limit: 7 },
    { panel: "activeSessions", limit: 13 },
    { panel: "tables" },
    { panel: "indexes", schema: "sales" },
    { panel: "storage" },
  ];
  const ANSWER: Readonly<Record<MonitoringPanel, unknown>> = {
    overview: OVERVIEW,
    performance: PERFORMANCE,
    slowQueries: SLOW,
    activeSessions: SESSIONS,
    tables: TABLES,
    indexes: INDEXES,
    storage: STORAGE,
  };
  const ARGS: Readonly<Record<MonitoringPanel, unknown[]>> = {
    overview: [],
    performance: [],
    slowQueries: [{ limit: 7 }],
    activeSessions: [{ limit: 13 }],
    tables: [{ schema: undefined }],
    indexes: [{ schema: "sales" }],
    storage: [],
  };

  test("readPanel calls the panel's member with today's argument and answers its answer by reference under the panel's key", async () => {
    await Promise.all(
      REQUESTS.map(async (request) => {
        const { reads, calls } = recordingReads();
        const answer = await readPanel(reads, request);
        expect(calls).toEqual([{ panel: request.panel, args: ARGS[request.panel] }]);
        expect(Object.keys(answer)).toEqual([request.panel]);
        expect((answer as Record<string, unknown>)[request.panel]).toBe(ANSWER[request.panel]);
      }),
    );
    const { reads, calls } = recordingReads();
    await readPanel(reads, { panel: "tables" });
    expect(Object.hasOwn(calls[0].args[0] as object, "schema")).toBe(true);
  });

  test("readPanel passes a member's rejection by reference", async () => {
    await Promise.all(
      REQUESTS.map(async (request) => {
        const failure = new Error(crypto.randomUUID());
        const { reads } = recordingReads({ [request.panel]: failure });
        let thrown: unknown;
        try {
          await readPanel(reads, request);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(failure);
      }),
    );
  });
});
