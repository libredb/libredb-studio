/**
 * Every part of every frame the memory test transport carries is read as the closed shape of its call type
 * (docs/providers/CONTRACT.md, clause C-20).
 *
 * Each case starts from a well-formed part, changes one thing, and asserts the exact refusal list: the rule, the call,
 * the part and a JSON Pointer into the part, never a value of the frame. Every planted string is generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FRAME_REFUSAL_RULES,
  type FramePart,
  type FrameRefusal,
  FrameRefusalError,
  type FrameRefusalRule,
  frameRefusalSentence,
  readFrame,
  SERVED_CALLS,
  type ServedCall,
} from "@libredb/provider-sdk/testing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft part each case bends into a shape the reader refuses.
type Json = Record<string, any>;

const SCHEMA = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"), "utf8"),
) as { $defs: Record<string, { enum?: string[] }> };

const marker = (): string => randomUUID();

function openContext(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    deadline: 1_900_000_000_000,
    engine: "exampledb",
    connectionId: marker(),
    seedId: marker(),
    connection: { host: marker(), port: 7000, user: marker(), password: marker(), allowInsecureAuth: false },
    tunnelFarEnd: { host: marker(), port: 22 },
    tunnelRoute: marker(),
    admittedFile: ":memory:",
    admittedHostPaths: { clientCertificatePath: `/${marker()}`, clientPrivateKeyPath: `/${marker()}` },
    tls: { mode: "verify-full", caCert: marker(), clientCert: marker(), clientKey: marker(), rejectUnauthorized: true },
    egress: { blocksPrivateHosts: true, source: "default" },
    trust: { certificates: [marker()] },
    policy: {
      readOnly: false,
      sendsStatements: true,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    },
    pool: { min: 0, max: 4, idleTimeout: 30_000, acquireTimeout: 5_000 },
    timezone: "UTC",
  };
  change(draft);
  return draft;
}

function executeAnswer(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    results: [
      {
        result: marker(),
        columns: [
          { name: "id", type: "int4" },
          {
            name: "embedding",
            vector: { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "index-map" },
          },
        ],
        rowCount: 2,
      },
    ],
    warnings: [
      { message: marker(), code: 1, severity: "notice" },
      { message: marker(), code: "01000" },
    ],
    executionTimeMs: 3,
    pageApplied: false,
    boundApplied: true,
    explainPlan: { plan: [marker()] },
  };
  change(draft);
  return draft;
}

/** A container as a tree answer carries it, with every optional member. */
function container(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = { path: [marker()], name: marker(), level: 0, isSessionDefault: true, kinds: ["table"] };
  change(draft);
  return draft;
}

/** An object as a tree answer carries it, with every optional member and a read range of each form. */
function databaseObject(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    path: [marker(), marker()],
    name: marker(),
    kind: "table",
    status: "INVALID",
    rowCount: 12,
    sizeBytes: 8192,
    readRanges: [{ key: marker() }, { prefix: marker() }, { start: marker(), end: marker() }],
  };
  change(draft);
  return draft;
}

/** An object's detail as a tree answer carries it, with every optional member. */
function objectDetail(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    path: [marker(), marker()],
    columns: [
      {
        name: "id",
        type: "integer",
        baseType: "int4",
        declaredType: "integer",
        nullable: false,
        isPrimary: true,
        defaultValue: "1",
        defaultExpression: "'1'",
        provenance: "sampled",
        projectable: true,
      },
      { name: "label", type: "text", nullable: true, isPrimary: false },
    ],
    indexes: [{ name: marker(), columns: ["id"], unique: true }],
    foreignKeys: [{ columnName: "id", referencedTable: marker(), referencedColumn: "id" }],
    exclusionConstraints: [{ name: marker(), definition: marker() }],
  };
  change(draft);
  return draft;
}

/** The overview panel with every optional member. */
function overview(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    version: marker(),
    uptime: marker(),
    startTime: new Date(1_700_000_000_000),
    activeConnections: 3,
    maxConnections: 100,
    databaseSize: marker(),
    databaseSizeBytes: 8192,
    tableCount: 12,
    tableCountSampledFrom: marker(),
    indexCount: 4,
  };
  change(draft);
  return draft;
}

/** One session of the active sessions panel, with every optional member. */
function session(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    pid: 4711,
    user: marker(),
    database: marker(),
    applicationName: marker(),
    clientAddr: marker(),
    state: "active",
    activity: "idle-in-transaction",
    query: marker(),
    queryStart: new Date(1_700_000_000_000),
    duration: "1s",
    durationMs: 1000,
    waitEventType: marker(),
    waitEvent: marker(),
    blocked: false,
    terminable: true,
  };
  change(draft);
  return draft;
}

/** One table of the table statistics panel, with every optional member. */
function tableStats(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    schemaName: marker(),
    tableName: marker(),
    rowCount: 10,
    liveRowCount: 9,
    deadRowCount: 1,
    tableSize: "8 kB",
    tableSizeBytes: 8192,
    indexSize: "16 kB",
    indexSizeBytes: 16384,
    totalSize: "24 kB",
    totalSizeBytes: 24576,
    lastVacuum: new Date(1_700_000_000_000),
    lastAnalyze: new Date(1_700_000_001_000),
    bloatRatio: 0.1,
  };
  change(draft);
  return draft;
}

/** One answer of each panel, with every optional member, then one with none where a panel has optional members. */
function panelAnswers(): readonly Json[] {
  return [
    { overview: overview() },
    {
      overview: overview((o) => {
        for (const key of ["startTime", "activeConnections", "databaseSizeBytes", "tableCountSampledFrom"])
          delete o[key];
      }),
    },
    {
      performance: {
        cacheHitRatio: 99.5,
        cacheHitAdvice: marker(),
        transactionsPerSecond: 1,
        queriesPerSecond: 2,
        bufferPoolUsage: 50,
        deadlocks: 0,
        checkpointWriteTime: "1 ms",
      },
    },
    { performance: {} },
    {
      slowQueries: [
        {
          queryId: marker(),
          query: marker(),
          calls: 3,
          totalTime: 30,
          avgTime: 10,
          minTime: 5,
          maxTime: 15,
          rows: 3,
          sharedBlksHit: 1,
          sharedBlksRead: 2,
        },
        { query: marker(), calls: 1, totalTime: 1, avgTime: 1, rows: 0 },
      ],
    },
    { slowQueries: [] },
    {
      activeSessions: [
        session(),
        {
          pid: marker(),
          user: marker(),
          database: marker(),
          state: marker(),
          query: marker(),
          duration: "0s",
          durationMs: 0,
        },
      ],
    },
    { tables: [tableStats(), { schemaName: marker(), tableName: marker(), totalSize: "0 B", totalSizeBytes: 0 }] },
    {
      indexes: [
        {
          schemaName: marker(),
          tableName: marker(),
          indexName: marker(),
          indexType: "btree",
          columns: ["id"],
          isUnique: true,
          isPrimary: true,
          indexSize: "8 kB",
          indexSizeBytes: 8192,
          scans: 3,
          usageRatio: 0.5,
        },
        {
          schemaName: marker(),
          tableName: marker(),
          indexName: marker(),
          columns: [],
          isUnique: false,
          isPrimary: false,
          indexSize: "0 B",
          scans: 0,
        },
      ],
    },
    {
      storage: [
        {
          name: marker(),
          location: marker(),
          size: "1 GB",
          sizeBytes: 1_073_741_824,
          usagePercent: 10,
          walSize: "16 MB",
          walSizeBytes: 16_777_216,
        },
        { name: marker(), size: "0 B", sizeBytes: 0 },
      ],
    },
  ];
}

/** One well-formed value of each part of each call, and a second, minimal one where a part has optional members. */
function wellFormed(): readonly (readonly [ServedCall, FramePart, unknown])[] {
  return [
    ["open", "context", openContext()],
    [
      "open",
      "context",
      openContext((c) => {
        for (const key of ["seedId", "tunnelFarEnd", "tunnelRoute", "admittedFile", "admittedHostPaths", "tls", "pool"])
          delete c[key];
        delete c.timezone;
        c.connection = {};
      }),
    ],
    ["open", "answer", { serverVersion: marker(), refine: { calls: { console: { cancel: "not-offered" } } } }],
    [
      "open",
      "answer",
      {
        engineUser: marker(),
        refine: { maintenance: [{ operation: "vacuum", perEntity: false, global: true }] },
      },
    ],
    ["open", "answer", {}],
    ["close", "context", { deadline: 1 }],
    ["health", "context", { deadline: 1 }],
    [
      "health",
      "answer",
      {
        activeConnections: 3,
        databaseSize: "1 GB",
        cacheHitRatio: "99%",
        slowQueries: [{ query: marker(), calls: 2, avgTime: "1 ms" }],
        activeSessions: [
          { pid: 4711, user: marker(), database: marker(), state: "active", query: marker(), duration: "1s" },
          { pid: marker(), user: marker(), database: marker(), state: "idle", query: "", duration: "0s" },
        ],
      },
    ],
    ["health", "answer", { databaseSize: "0 B", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] }],
    ["console.execute", "context", { deadline: 1 }],
    [
      "console.execute",
      "request",
      {
        statement: marker(),
        runId: marker(),
        params: [1, marker(), null, [2], { a: 1 }],
        page: { limit: 500, offset: 0 },
        scope: marker(),
      },
    ],
    ["console.execute", "request", { statement: marker(), page: { unlimited: true } }],
    ["console.execute", "request", { statement: marker(), page: { unlimited: true }, transaction: true }],
    ["console.execute", "answer", executeAnswer()],
    ["console.execute", "answer", executeAnswer((a) => (a.sessionState = "in-transaction"))],
    [
      "console.execute",
      "answer",
      executeAnswer((a) => {
        a.results = [];
        a.warnings = [];
        delete a.boundApplied;
        delete a.explainPlan;
      }),
    ],
    ["console.cancel", "context", { deadline: 1 }],
    ["console.cancel", "request", { runId: marker() }],
    ["console.cancel", "answer", { cancelled: true }],
    ["console.endScope", "context", { deadline: 1 }],
    ["console.endScope", "request", { scope: marker() }],
    ["console.endScope", "answer", { openTransaction: "rolled-back" }],
    ["console.transaction", "context", { deadline: 1 }],
    ["console.transaction", "request", { action: "begin", requireReportedState: true }],
    ["console.transaction", "request", { action: "begin" }],
    ["console.transaction", "request", { action: "commit" }],
    ["console.transaction", "request", { action: "rollback" }],
    ["console.transaction", "request", { action: "state" }],
    ["console.transaction", "answer", { sessionState: "in-transaction", stateReported: false }],
    ["console.transaction", "answer", { sessionState: "not-in-transaction" }],
    ["console.transaction", "answer", { sessionState: "unknown" }],
    ["objects.tree", "context", { deadline: 1 }],
    ["objects.tree", "request", { action: "containers", parent: [marker()] }],
    ["objects.tree", "request", { action: "containers" }],
    ["objects.tree", "request", { action: "count", container: [marker()] }],
    ["objects.tree", "request", { action: "list", container: [marker()], kind: "table" }],
    ["objects.tree", "request", { action: "describe", path: [marker(), marker()], kind: "table" }],
    [
      "objects.tree",
      "request",
      { action: "describeMany", container: [marker()], kind: "table", limit: 100, defaultSql: true },
    ],
    ["objects.tree", "request", { action: "describeMany", container: [], kind: "table" }],
    ["objects.tree", "answer", { containers: [container(), container((c) => delete c.kinds)] }],
    ["objects.tree", "answer", { containers: [] }],
    [
      "objects.tree",
      "answer",
      {
        counts: { table: { count: 3 }, view: { count: 1204, sampledFrom: marker() }, index: { unavailable: marker() } },
      },
    ],
    ["objects.tree", "answer", { counts: {} }],
    ["objects.tree", "answer", { objects: [databaseObject(), { path: [marker()], name: marker(), kind: "view" }] }],
    ["objects.tree", "answer", { detail: objectDetail() }],
    [
      "objects.tree",
      "answer",
      {
        detail: objectDetail((d) => {
          d.indexes = { unavailable: marker() };
          delete d.exclusionConstraints;
        }),
      },
    ],
    ["objects.tree", "answer", { details: [objectDetail()], truncated: { limit: 1, reason: marker() } }],
    ["objects.tree", "answer", { details: [] }],
    ["maintenance.run", "context", { deadline: 1 }],
    ["maintenance.run", "request", { operation: "vacuum", target: marker(), container: marker() }],
    ["maintenance.run", "request", { operation: "kill", target: "4711" }],
    ["maintenance.run", "request", { operation: "analyze" }],
    [
      "maintenance.run",
      "answer",
      { success: true, executionTime: 12, message: marker(), rows: [{ key: marker(), value: 1 }], fields: ["key"] },
    ],
    ["maintenance.run", "answer", { success: false, executionTime: 0, message: marker() }],
    ["maintenance.preview", "context", { deadline: 1 }],
    ["maintenance.preview", "request", { operation: "release", path: [marker(), marker()] }],
    [
      "maintenance.preview",
      "answer",
      { summary: marker(), facts: [{ label: marker(), value: marker() }], refusal: marker(), note: marker() },
    ],
    ["maintenance.preview", "answer", { summary: marker(), facts: [] }],
    ["monitoring.panel", "context", { deadline: 1 }],
    ["monitoring.panel", "request", { panel: "overview" }],
    ["monitoring.panel", "request", { panel: "slowQueries", limit: 10 }],
    ["monitoring.panel", "request", { panel: "tables", schema: marker() }],
    ["monitoring.panel", "request", { panel: "indexes" }],
    ...panelAnswers().map((answer) => ["monitoring.panel", "answer", answer] as const),
    ["monitoring.poolStats", "context", { deadline: 1 }],
    ["monitoring.poolStats", "answer", { total: 5, idle: 2, active: 3, waiting: 0, max: 10 }],
    ["monitoring.poolStats", "answer", { total: 0, idle: 0, active: 0, waiting: 0 }],
    ["result.next", "request", { maxRows: 100, maxBytes: 1_048_576 }],
    [
      "result.next",
      "answer",
      {
        rows: [
          [1, marker()],
          [null, { a: [1] }],
        ],
        done: true,
      },
    ],
    ["result.next", "answer", { rows: [], done: false }],
  ];
}

/** readFrame over any call and part, for a table of cases; each call's own parts are typed at its call site. */
function read(call: ServedCall, part: FramePart, value: unknown): readonly FrameRefusal[] {
  return (readFrame as (call: ServedCall, part: FramePart, value: unknown) => readonly FrameRefusal[])(
    call,
    part,
    value,
  );
}

function refusal(
  rule: FrameRefusalRule,
  call: ServedCall,
  part: FramePart,
  pointer: string,
  name?: string,
): FrameRefusal {
  return name === undefined ? { rule, call, part, pointer } : { rule, call, part, pointer, name };
}

describe("readFrame", () => {
  test("a well-formed frame of every call and part is admitted", () => {
    const cases = wellFormed();

    for (const [call, part, value] of cases) expect([call, part, read(call, part, value)]).toEqual([call, part, []]);
    expect([...new Set(cases.map(([call, part]) => `${call} ${part}`))]).toEqual([
      "open context",
      "open answer",
      "close context",
      "health context",
      "health answer",
      "console.execute context",
      "console.execute request",
      "console.execute answer",
      "console.cancel context",
      "console.cancel request",
      "console.cancel answer",
      "console.endScope context",
      "console.endScope request",
      "console.endScope answer",
      "console.transaction context",
      "console.transaction request",
      "console.transaction answer",
      "objects.tree context",
      "objects.tree request",
      "objects.tree answer",
      "maintenance.run context",
      "maintenance.run request",
      "maintenance.run answer",
      "maintenance.preview context",
      "maintenance.preview request",
      "maintenance.preview answer",
      "monitoring.panel context",
      "monitoring.panel request",
      "monitoring.panel answer",
      "monitoring.poolStats context",
      "monitoring.poolStats answer",
      "result.next request",
      "result.next answer",
    ]);
    expect(new Set(cases.map(([call]) => call))).toEqual(
      new Set(SERVED_CALLS.filter((call) => call !== "result.close")),
    );
  });

  test("a key a frame's shape does not define is refused as frame-key-unknown at its pointer", () => {
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.extra = marker())),
      ),
    ).toEqual([refusal("frame-key-unknown", "open", "context", "/extra", "extra")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.tls["a/b~c"] = 1)),
      ),
    ).toEqual([refusal("frame-key-unknown", "open", "context", "/tls/a~1b~0c", "a/b~c")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.signal = {})),
      ),
    ).toEqual([refusal("frame-key-unknown", "open", "context", "/signal", "signal")]);
    expect(readFrame("open", "answer", { handle: {} })).toEqual([
      refusal("frame-key-unknown", "open", "answer", "/handle", "handle"),
    ]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => {
          a.results[0].columns[1].vector.extra = 1;
          a.warnings[1].extra = 1;
        }),
      ),
    ).toEqual([
      refusal("frame-key-unknown", "console.execute", "answer", "/results/0/columns/1/vector/extra", "extra"),
      refusal("frame-key-unknown", "console.execute", "answer", "/warnings/1/extra", "extra"),
    ]);
    expect(readFrame("result.next", "request", { maxRows: 1, maxBytes: 1, rows: 1 })).toEqual([
      refusal("frame-key-unknown", "result.next", "request", "/rows", "rows"),
    ]);
    expect(
      readFrame("console.cancel", "answer", Object.defineProperty({ cancelled: true }, "hidden", { value: 1 })),
    ).toEqual([refusal("frame-key-unknown", "console.cancel", "answer", "/hidden", "hidden")]);
    expect(readFrame("objects.tree", "request", { action: "count", container: [], extra: 1 })).toEqual([
      refusal("frame-key-unknown", "objects.tree", "request", "/extra", "extra"),
    ]);
    expect(
      readFrame("objects.tree", "answer", {
        objects: [databaseObject((o) => (o.readRanges[0].extra = 1))],
      }),
    ).toEqual([refusal("frame-key-unknown", "objects.tree", "answer", "/objects/0/readRanges/0/extra", "extra")]);
    expect(
      readFrame("objects.tree", "answer", {
        detail: objectDetail((d) => {
          d.columns[0].comment = marker();
          d.indexes[0].extra = 1;
        }),
      }),
    ).toEqual([
      refusal("frame-key-unknown", "objects.tree", "answer", "/detail/columns/0/comment", "comment"),
      refusal("frame-key-unknown", "objects.tree", "answer", "/detail/indexes/0/extra", "extra"),
    ]);
    expect(readFrame("maintenance.run", "request", { operation: "vacuum", path: [marker()] })).toEqual([
      refusal("frame-key-unknown", "maintenance.run", "request", "/path", "path"),
    ]);
    expect(
      readFrame("maintenance.preview", "answer", { summary: marker(), facts: [{ label: "a", value: "b", unit: "c" }] }),
    ).toEqual([refusal("frame-key-unknown", "maintenance.preview", "answer", "/facts/0/unit", "unit")]);
    expect(readFrame("monitoring.panel", "request", { panel: "storage", limit: 1 })).toEqual([
      refusal("frame-key-unknown", "monitoring.panel", "request", "/limit", "limit"),
    ]);
    expect(readFrame("monitoring.poolStats", "answer", { total: 0, idle: 0, active: 0, waiting: 0, min: 0 })).toEqual([
      refusal("frame-key-unknown", "monitoring.poolStats", "answer", "/min", "min"),
    ]);
    expect(
      readFrame("health", "answer", {
        databaseSize: "0 B",
        cacheHitRatio: "N/A",
        slowQueries: [{ query: marker(), calls: 1, avgTime: "1 ms", rows: 1 }],
        activeSessions: [],
      }),
    ).toEqual([refusal("frame-key-unknown", "health", "answer", "/slowQueries/0/rows", "rows")]);
  });

  test("a required key a frame lacks is refused as frame-key-missing", () => {
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => delete c.egress),
      ),
    ).toEqual([refusal("frame-key-missing", "open", "context", "/egress", "egress")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => delete c.policy.managed),
      ),
    ).toEqual([refusal("frame-key-missing", "open", "context", "/policy/managed", "managed")]);
    expect(readFrame("close", "context", {})).toEqual([
      refusal("frame-key-missing", "close", "context", "/deadline", "deadline"),
    ]);
    expect(readFrame("console.execute", "request", { page: { unlimited: true } })).toEqual([
      refusal("frame-key-missing", "console.execute", "request", "/statement", "statement"),
    ]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => delete a.results[0].columns),
      ),
    ).toEqual([refusal("frame-key-missing", "console.execute", "answer", "/results/0/columns", "columns")]);
    expect(readFrame("result.next", "answer", { rows: [] })).toEqual([
      refusal("frame-key-missing", "result.next", "answer", "/done", "done"),
    ]);
    expect(readFrame("monitoring.panel", "request", { panel: "activeSessions" })).toEqual([
      refusal("frame-key-missing", "monitoring.panel", "request", "/limit", "limit"),
    ]);
    expect(readFrame("monitoring.poolStats", "answer", { total: 0, idle: 0, active: 0 })).toEqual([
      refusal("frame-key-missing", "monitoring.poolStats", "answer", "/waiting", "waiting"),
    ]);
    expect(readFrame("health", "context", {})).toEqual([
      refusal("frame-key-missing", "health", "context", "/deadline", "deadline"),
    ]);
  });

  test("a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable", () => {
    const unreadable = (call: ServedCall, part: FramePart, pointer: string) =>
      refusal("frame-value-unreadable", call, part, pointer);
    const withHole: unknown[] = [];
    withHole.length = 2 ** 32 - 1;
    let reads = 0;
    const accessor = Object.defineProperty({ deadline: 1 }, "deadline", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });

    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.tls.mode = "verify")),
      ),
    ).toEqual([unreadable("open", "context", "/tls/mode")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.egress.source = "inferred")),
      ),
    ).toEqual([unreadable("open", "context", "/egress/source")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => {
          c.deadline = String(c.deadline);
          c.trust.certificates = [1];
          c.pool.max = null;
          c.policy.readOnly = "false";
          c.tunnelFarEnd = [];
        }),
      ),
    ).toEqual([
      unreadable("open", "context", "/deadline"),
      unreadable("open", "context", "/tunnelFarEnd"),
      unreadable("open", "context", "/trust/certificates/0"),
      unreadable("open", "context", "/policy/readOnly"),
      unreadable("open", "context", "/pool/max"),
    ]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => {
          a.results[0].columns[1].vector = { kind: "ragged", dtype: "float128", dimension: "3", sparseEncoding: "csr" };
          a.warnings[0].code = true;
          a.boundApplied = false;
        }),
      ),
    ).toEqual([
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/kind"),
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/dtype"),
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/dimension"),
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/sparseEncoding"),
      unreadable("console.execute", "answer", "/warnings/0/code"),
      unreadable("console.execute", "answer", "/boundApplied"),
    ]);
    expect(readFrame("console.endScope", "answer", { openTransaction: "open" })).toEqual([
      unreadable("console.endScope", "answer", "/openTransaction"),
    ]);
    expect(readFrame("console.transaction", "answer", { sessionState: "open", stateReported: "yes" })).toEqual([
      unreadable("console.transaction", "answer", "/sessionState"),
      unreadable("console.transaction", "answer", "/stateReported"),
    ]);
    expect(
      readFrame("console.execute", "request", { statement: "s", page: { unlimited: true }, transaction: false }),
    ).toEqual([unreadable("console.execute", "request", "/transaction")]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => (a.sessionState = "aborted")),
      ),
    ).toEqual([unreadable("console.execute", "answer", "/sessionState")]);
    expect(readFrame("result.next", "answer", { rows: [[1], 2], done: true })).toEqual([
      unreadable("result.next", "answer", "/rows/1"),
    ]);
    expect(readFrame("console.cancel", "answer", null)).toEqual([unreadable("console.cancel", "answer", "")]);
    expect(
      readFrame("console.execute", "request", { statement: "s", params: withHole, page: { unlimited: true } }),
    ).toEqual([unreadable("console.execute", "request", "/params/0")]);
    expect(readFrame("close", "context", accessor)).toEqual([unreadable("close", "context", "/deadline")]);
    expect(
      readFrame("objects.tree", "request", { action: "describeMany", container: [1], kind: "table", limit: "10" }),
    ).toEqual([unreadable("objects.tree", "request", "/container/0"), unreadable("objects.tree", "request", "/limit")]);
    expect(
      readFrame("objects.tree", "answer", {
        containers: [container((c) => (c.level = "0")), container((c) => (c.isSessionDefault = "yes"))],
      }),
    ).toEqual([
      unreadable("objects.tree", "answer", "/containers/0/level"),
      unreadable("objects.tree", "answer", "/containers/1/isSessionDefault"),
    ]);
    expect(
      readFrame("objects.tree", "answer", {
        detail: objectDetail((d) => {
          d.columns[0].provenance = "declared";
          d.columns[1].nullable = "yes";
          d.foreignKeys[0].referencedColumn = null;
        }),
      }),
    ).toEqual([
      unreadable("objects.tree", "answer", "/detail/columns/0/provenance"),
      unreadable("objects.tree", "answer", "/detail/columns/1/nullable"),
      unreadable("objects.tree", "answer", "/detail/foreignKeys/0/referencedColumn"),
    ]);
    expect(readFrame("open", "answer", { serverVersion: marker(), engineUser: 1 })).toEqual([
      unreadable("open", "answer", "/engineUser"),
    ]);
    expect(readFrame("maintenance.run", "request", { operation: "shrink", target: 4711 })).toEqual([
      unreadable("maintenance.run", "request", "/operation"),
      unreadable("maintenance.run", "request", "/target"),
    ]);
    expect(
      readFrame("maintenance.preview", "answer", { summary: marker(), facts: [{ label: "a", value: 1 }] }),
    ).toEqual([unreadable("maintenance.preview", "answer", "/facts/0/value")]);
    expect(readFrame("monitoring.panel", "request", { panel: "sessions" })).toEqual([
      unreadable("monitoring.panel", "request", "/panel"),
    ]);
    expect(readFrame("monitoring.poolStats", "answer", { total: "5", idle: 0, active: 0, waiting: null })).toEqual([
      unreadable("monitoring.poolStats", "answer", "/total"),
      unreadable("monitoring.poolStats", "answer", "/waiting"),
    ]);
    expect(
      readFrame("health", "answer", { databaseSize: 0, cacheHitRatio: 99, slowQueries: [], activeSessions: [] }),
    ).toEqual([unreadable("health", "answer", "/databaseSize"), unreadable("health", "answer", "/cacheHitRatio")]);
    expect(reads).toBe(0);
  });

  test("a maintenance run request and answer are each read as their closed shape", () => {
    const answer = { success: true, executionTime: 3, message: marker() };
    const unreadable = (part: FramePart, pointer: string) =>
      refusal("frame-value-unreadable", "maintenance.run", part, pointer);

    for (const operation of SCHEMA.$defs.maintenanceOperation?.enum ?? []) {
      expect(readFrame("maintenance.run", "request", { operation })).toEqual([]);
    }
    expect(readFrame("maintenance.run", "request", {})).toEqual([
      refusal("frame-key-missing", "maintenance.run", "request", "/operation", "operation"),
    ]);
    expect(readFrame("maintenance.run", "request", { operation: "vacuum", target: null, container: 1 })).toEqual([
      unreadable("request", "/target"),
      unreadable("request", "/container"),
    ]);
    expect(
      readFrame("maintenance.run", "answer", { ...answer, rows: [{ a: [1, { b: null }] }], fields: ["a"] }),
    ).toEqual([]);
    expect(readFrame("maintenance.run", "answer", { ...answer, rows: [1, [2]], fields: [3] })).toEqual([
      unreadable("answer", "/rows/0"),
      unreadable("answer", "/rows/1"),
      unreadable("answer", "/fields/0"),
    ]);
    expect(readFrame("maintenance.run", "answer", { success: "yes", executionTime: "3", message: 1 })).toEqual([
      unreadable("answer", "/success"),
      unreadable("answer", "/executionTime"),
      unreadable("answer", "/message"),
    ]);
    expect(readFrame("maintenance.run", "answer", { message: marker() })).toEqual([
      refusal("frame-key-missing", "maintenance.run", "answer", "/success", "success"),
      refusal("frame-key-missing", "maintenance.run", "answer", "/executionTime", "executionTime"),
    ]);
    expect(readFrame("maintenance.run", "answer", { ...answer, columns: [] })).toEqual([
      refusal("frame-key-unknown", "maintenance.run", "answer", "/columns", "columns"),
    ]);
    expect(readFrame("maintenance.run", "answer", { ...answer, fields: ["a"] })).toEqual([]);
    expect(readFrame("maintenance.run", "answer", { ...answer, rows: [{ a: 1 }] })).toEqual([
      refusal("frame-key-missing", "maintenance.run", "answer", "/fields", "fields"),
    ]);
  });

  test("a maintenance preview request and answer are each read as their closed shape", () => {
    const unreadable = (part: FramePart, pointer: string) =>
      refusal("frame-value-unreadable", "maintenance.preview", part, pointer);

    expect(readFrame("maintenance.preview", "request", { operation: "release", path: ["a"] })).toEqual([]);
    expect(readFrame("maintenance.preview", "request", { operation: "release", path: [] })).toEqual([
      unreadable("request", "/path"),
    ]);
    expect(readFrame("maintenance.preview", "request", { operation: "release" })).toEqual([
      refusal("frame-key-missing", "maintenance.preview", "request", "/path", "path"),
    ]);
    expect(readFrame("maintenance.preview", "request", { operation: "evict", path: ["a", 1], target: "a" })).toEqual([
      unreadable("request", "/operation"),
      unreadable("request", "/path/1"),
      refusal("frame-key-unknown", "maintenance.preview", "request", "/target", "target"),
    ]);
    expect(readFrame("maintenance.preview", "answer", { facts: [{ label: marker() }] })).toEqual([
      refusal("frame-key-missing", "maintenance.preview", "answer", "/facts/0/value", "value"),
      refusal("frame-key-missing", "maintenance.preview", "answer", "/summary", "summary"),
    ]);
    expect(readFrame("maintenance.preview", "answer", { summary: 1, facts: {}, refusal: false, note: null })).toEqual([
      unreadable("answer", "/summary"),
      unreadable("answer", "/facts"),
      unreadable("answer", "/refusal"),
      unreadable("answer", "/note"),
    ]);
  });

  test("a monitoring panel request is the closed shape of the panel it names", () => {
    const request = (value: unknown) => readFrame("monitoring.panel", "request", value);
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "monitoring.panel", "request", pointer);
    const unknown = (pointer: string, key: string) =>
      refusal("frame-key-unknown", "monitoring.panel", "request", pointer, key);
    let reads = 0;
    const accessor = Object.defineProperty({}, "panel", {
      enumerable: true,
      get() {
        reads += 1;
        return "overview";
      },
    });

    for (const panel of ["overview", "performance", "storage"]) {
      expect(request({ panel })).toEqual([]);
      expect(request({ panel, limit: 1, schema: marker() })).toEqual([
        unknown("/limit", "limit"),
        unknown("/schema", "schema"),
      ]);
    }
    for (const panel of ["slowQueries", "activeSessions"]) {
      expect(request({ panel, limit: 25 })).toEqual([]);
      expect(request({ panel })).toEqual([
        refusal("frame-key-missing", "monitoring.panel", "request", "/limit", "limit"),
      ]);
      expect(request({ panel, limit: "25" })).toEqual([unreadable("/limit")]);
      expect(request({ panel, limit: 1, schema: marker() })).toEqual([unknown("/schema", "schema")]);
    }
    for (const panel of ["tables", "indexes"]) {
      expect(request({ panel })).toEqual([]);
      expect(request({ panel, schema: marker() })).toEqual([]);
      expect(request({ panel, schema: 1 })).toEqual([unreadable("/schema")]);
      expect(request({ panel, limit: 1 })).toEqual([unknown("/limit", "limit")]);
    }
    expect(request({})).toEqual([refusal("frame-key-missing", "monitoring.panel", "request", "/panel", "panel")]);
    for (const panel of ["sessions", "__proto__", "constructor", 1, null])
      expect(request({ panel })).toEqual([unreadable("/panel")]);
    expect(request(accessor)).toEqual([unreadable("/panel")]);
    expect(request([])).toEqual([unreadable("")]);
    expect(request(null)).toEqual([unreadable("")]);
    expect(reads).toBe(0);
  });

  test("a monitoring panel answer is exactly one of its seven forms, each read as its closed shape", () => {
    const answer = (value: unknown) => readFrame("monitoring.panel", "answer", value);
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "monitoring.panel", "answer", pointer);
    const missing = (pointer: string, key: string) =>
      refusal("frame-key-missing", "monitoring.panel", "answer", pointer, key);
    const unknown = (pointer: string, key: string) =>
      refusal("frame-key-unknown", "monitoring.panel", "answer", pointer, key);

    for (const value of panelAnswers()) expect(answer(value)).toEqual([]);
    expect(answer({ overview: overview(), storage: [] })).toEqual([unreadable("")]);
    expect(answer({ sessions: [] })).toEqual([unreadable("")]);
    expect(answer({})).toEqual([unreadable("")]);
    expect(answer([])).toEqual([unreadable("")]);
    expect(answer(null)).toEqual([unreadable("")]);
    expect(answer({ overview: overview((o) => delete o.maxConnections) })).toEqual([
      missing("/overview/maxConnections", "maxConnections"),
    ]);
    expect(answer({ overview: overview((o) => (o.startTime = "2026-01-01T00:00:00.000Z")) })).toEqual([
      unreadable("/overview/startTime"),
    ]);
    expect(answer({ performance: { cacheHitRatio: "99", hitRate: 1 } })).toEqual([
      unreadable("/performance/cacheHitRatio"),
      unknown("/performance/hitRate", "hitRate"),
    ]);
    expect(answer({ slowQueries: [{ query: marker(), calls: 1, totalTime: 1, avgTime: "1", rows: 0 }] })).toEqual([
      unreadable("/slowQueries/0/avgTime"),
    ]);
    expect(
      answer({
        activeSessions: [
          session((r) => (r.activity = "busy")),
          session((r) => (r.pid = null)),
          session((r) => (r.queryStart = 1)),
        ],
      }),
    ).toEqual([
      unreadable("/activeSessions/0/activity"),
      unreadable("/activeSessions/1/pid"),
      unreadable("/activeSessions/2/queryStart"),
    ]);
    for (const activity of ["active", "idle", "idle-in-transaction", "waiting", "other"]) {
      expect(answer({ activeSessions: [session((r) => (r.activity = activity))] })).toEqual([]);
    }
    expect(
      answer({ tables: [tableStats((t) => (t.lastVacuum = {})), tableStats((t) => delete t.totalSizeBytes)] }),
    ).toEqual([unreadable("/tables/0/lastVacuum"), missing("/tables/1/totalSizeBytes", "totalSizeBytes")]);
    expect(answer({ indexes: [{ schemaName: marker() }] })).toEqual(
      ["tableName", "indexName", "columns", "isUnique", "isPrimary", "indexSize", "scans"].map((key) =>
        missing(`/indexes/0/${key}`, key),
      ),
    );
    expect(answer({ storage: {} })).toEqual([unreadable("/storage")]);
    expect(answer({ storage: [{ name: marker(), size: "0 B", sizeBytes: 0, extra: 1 }] })).toEqual([
      unknown("/storage/0/extra", "extra"),
    ]);
  });

  test("a pool statistics answer and a health answer are each read as their closed shape", () => {
    const pool = (value: unknown) => readFrame("monitoring.poolStats", "answer", value);
    const unreadable = (pointer: string) =>
      refusal("frame-value-unreadable", "monitoring.poolStats", "answer", pointer);

    expect(pool({ total: 5, idle: 2, active: 3, waiting: 0, max: 10 })).toEqual([]);
    expect(pool({ total: 5, idle: 2, active: 3, waiting: 0 })).toEqual([]);
    expect(pool({ total: 5, idle: 2, active: 3, waiting: 0, max: "10" })).toEqual([unreadable("/max")]);
    expect(pool({})).toEqual(
      ["total", "idle", "active", "waiting"].map((key) =>
        refusal("frame-key-missing", "monitoring.poolStats", "answer", `/${key}`, key),
      ),
    );
    expect(pool(null)).toEqual([unreadable("")]);

    const health = (value: unknown) => readFrame("health", "answer", value);
    const healthUnreadable = (pointer: string) => refusal("frame-value-unreadable", "health", "answer", pointer);
    const session = { pid: 1, user: marker(), database: marker(), state: "active", query: marker(), duration: "1s" };
    expect(health({ databaseSize: "0 B", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [session] })).toEqual(
      [],
    );
    expect(
      health({
        activeConnections: "3",
        databaseSize: "0 B",
        cacheHitRatio: "N/A",
        slowQueries: [{ query: marker(), calls: "1", avgTime: 1 }],
        activeSessions: [{ ...session, pid: null, blocked: true }],
      }),
    ).toEqual([
      healthUnreadable("/activeConnections"),
      healthUnreadable("/slowQueries/0/calls"),
      healthUnreadable("/slowQueries/0/avgTime"),
      healthUnreadable("/activeSessions/0/pid"),
      refusal("frame-key-unknown", "health", "answer", "/activeSessions/0/blocked", "blocked"),
    ]);
    expect(health({ databaseSize: "0 B" })).toEqual([
      refusal("frame-key-missing", "health", "answer", "/cacheHitRatio", "cacheHitRatio"),
      refusal("frame-key-missing", "health", "answer", "/slowQueries", "slowQueries"),
      refusal("frame-key-missing", "health", "answer", "/activeSessions", "activeSessions"),
    ]);
    expect(health({ databaseSize: "0 B", cacheHitRatio: "N/A", slowQueries: {}, activeSessions: null })).toEqual([
      healthUnreadable("/slowQueries"),
      healthUnreadable("/activeSessions"),
    ]);
  });

  test("a timestamp member admits a Date and nothing else", () => {
    const startTime = (value: unknown) =>
      readFrame("monitoring.panel", "answer", { overview: overview((o) => (o.startTime = value)) });
    const unreadable = [refusal("frame-value-unreadable", "monitoring.panel", "answer", "/overview/startTime")];

    expect(startTime(new Date(0))).toEqual([]);
    expect(startTime(new (class extends Date {})(1))).toEqual([]);
    for (const value of [new Date(Number.NaN), "1970-01-01T00:00:00.000Z", 0, {}, null, [new Date(0)]]) {
      expect(startTime(value)).toEqual(unreadable);
    }
  });

  test("a page bound is exactly one of its two forms", () => {
    const page = (bound: unknown) => readFrame("console.execute", "request", { statement: marker(), page: bound });
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "console.execute", "request", pointer);

    expect(page({ limit: 1, offset: 0 })).toEqual([]);
    expect(page({ unlimited: true })).toEqual([]);
    expect(page({ limit: 1, offset: 0, unlimited: true })).toEqual([unreadable("/page")]);
    expect(page({})).toEqual([unreadable("/page")]);
    expect(page([])).toEqual([unreadable("/page")]);
    expect(page({ unlimited: false })).toEqual([unreadable("/page/unlimited")]);
    expect(page({ limit: 1 })).toEqual([
      refusal("frame-key-missing", "console.execute", "request", "/page/offset", "offset"),
    ]);
  });

  test("a transaction request is one of its actions, and only begin carries requireReportedState", () => {
    const transaction = (request: unknown) => readFrame("console.transaction", "request", request);
    const unreadable = (pointer: string) =>
      refusal("frame-value-unreadable", "console.transaction", "request", pointer);
    let reads = 0;
    const accessor = Object.defineProperty({}, "action", {
      enumerable: true,
      get() {
        reads += 1;
        return "begin";
      },
    });

    for (const action of ["begin", "commit", "rollback", "state"]) expect(transaction({ action })).toEqual([]);
    expect(transaction({ action: "begin", requireReportedState: true })).toEqual([]);
    expect(transaction({ action: "begin", requireReportedState: false })).toEqual([
      unreadable("/requireReportedState"),
    ]);
    for (const action of ["commit", "rollback", "state"]) {
      expect(transaction({ action, requireReportedState: true })).toEqual([
        refusal("frame-key-unknown", "console.transaction", "request", "/requireReportedState", "requireReportedState"),
      ]);
    }
    expect(transaction({ action: "savepoint" })).toEqual([unreadable("/action")]);
    expect(transaction({ action: 1 })).toEqual([unreadable("/action")]);
    expect(transaction({})).toEqual([
      refusal("frame-key-missing", "console.transaction", "request", "/action", "action"),
    ]);
    expect(transaction(accessor)).toEqual([unreadable("/action")]);
    expect(transaction(null)).toEqual([unreadable("")]);
    expect(transaction([])).toEqual([unreadable("")]);
    expect(reads).toBe(0);
  });

  test("a tree request is one of its actions, each with its own members", () => {
    const tree = (request: unknown) => readFrame("objects.tree", "request", request);
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "objects.tree", "request", pointer);
    const unknown = (key: string) => refusal("frame-key-unknown", "objects.tree", "request", `/${key}`, key);
    const missing = (key: string) => refusal("frame-key-missing", "objects.tree", "request", `/${key}`, key);
    let reads = 0;
    const accessor = Object.defineProperty({}, "action", {
      enumerable: true,
      get() {
        reads += 1;
        return "containers";
      },
    });
    const container = [marker()];

    expect(tree({ action: "containers" })).toEqual([]);
    expect(tree({ action: "containers", parent: container })).toEqual([]);
    expect(tree({ action: "containers", container })).toEqual([unknown("container")]);
    expect(tree({ action: "containers", parent: marker() })).toEqual([unreadable("/parent")]);
    expect(tree({ action: "count", container })).toEqual([]);
    expect(tree({ action: "count" })).toEqual([missing("container")]);
    expect(tree({ action: "count", container, kind: "table" })).toEqual([unknown("kind")]);
    expect(tree({ action: "list", container, kind: "table" })).toEqual([]);
    expect(tree({ action: "list", container })).toEqual([missing("kind")]);
    expect(tree({ action: "list", container, kind: "table", limit: 1 })).toEqual([unknown("limit")]);
    expect(tree({ action: "describe", path: container, kind: "table" })).toEqual([]);
    expect(tree({ action: "describe", container, kind: "table" })).toEqual([unknown("container"), missing("path")]);
    expect(tree({ action: "describeMany", container, kind: "table", limit: 5, defaultSql: true })).toEqual([]);
    expect(tree({ action: "describeMany", container, kind: "table", defaultSql: false })).toEqual([
      unreadable("/defaultSql"),
    ]);
    expect(tree({ action: "describeMany", container, kind: "table", parent: container })).toEqual([unknown("parent")]);
    expect(tree({ action: "describeMany", kind: 1 })).toEqual([unreadable("/kind"), missing("container")]);
    expect(tree({ action: "search", container })).toEqual([unreadable("/action")]);
    expect(tree({ action: 1 })).toEqual([unreadable("/action")]);
    expect(tree({ action: "toString" })).toEqual([unreadable("/action")]);
    expect(tree({ container })).toEqual([missing("action")]);
    expect(tree(accessor)).toEqual([unreadable("/action")]);
    expect(tree(null)).toEqual([unreadable("")]);
    expect(tree([])).toEqual([unreadable("")]);
    expect(reads).toBe(0);
  });

  test("a tree answer is exactly one of its five forms, each read as its closed shape", () => {
    const tree = (answer: unknown) => readFrame("objects.tree", "answer", answer);
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "objects.tree", "answer", pointer);
    const missing = (pointer: string, key: string) =>
      refusal("frame-key-missing", "objects.tree", "answer", pointer, key);
    let reads = 0;
    const accessor = Object.defineProperty({}, "table", {
      enumerable: true,
      get() {
        reads += 1;
        return { count: 1 };
      },
    });

    expect(tree({ containers: [], objects: [] })).toEqual([unreadable("")]);
    expect(tree({ counts: {}, detail: objectDetail() })).toEqual([unreadable("")]);
    expect(tree({ extra: 1 })).toEqual([unreadable("")]);
    expect(tree({})).toEqual([unreadable("")]);
    expect(tree([])).toEqual([unreadable("")]);
    expect(tree(null)).toEqual([unreadable("")]);
    expect(tree({ containers: {} })).toEqual([unreadable("/containers")]);
    expect(tree({ containers: [container((c) => delete c.path)] })).toEqual([missing("/containers/0/path", "path")]);
    expect(tree({ counts: { table: { count: 1, unavailable: marker() } } })).toEqual([unreadable("/counts/table")]);
    expect(tree({ counts: { table: {} } })).toEqual([unreadable("/counts/table")]);
    expect(tree({ counts: { table: { count: "1" }, view: { sampledFrom: marker() } } })).toEqual([
      unreadable("/counts/table/count"),
      missing("/counts/view/count", "count"),
    ]);
    expect(tree({ counts: { table: { unavailable: 1 } } })).toEqual([unreadable("/counts/table/unavailable")]);
    expect(tree({ counts: { "a/b": 2 } })).toEqual([unreadable("/counts/a~1b")]);
    expect(tree({ counts: [] })).toEqual([unreadable("/counts")]);
    expect(tree({ counts: accessor })).toEqual([unreadable("/counts/table")]);
    expect(tree({ counts: Object.defineProperty({}, "hidden", { value: { count: "1" } }) })).toEqual([
      unreadable("/counts/hidden/count"),
    ]);
    expect(
      tree({
        objects: [
          databaseObject((o) => (o.readRanges = [{ key: marker(), prefix: marker() }, { start: marker() }, {}])),
        ],
      }),
    ).toEqual([
      unreadable("/objects/0/readRanges/0"),
      missing("/objects/0/readRanges/1/end", "end"),
      unreadable("/objects/0/readRanges/2"),
    ]);
    expect(tree({ objects: [databaseObject((o) => delete o.kind)] })).toEqual([missing("/objects/0/kind", "kind")]);
    expect(
      tree({
        detail: objectDetail((d) => {
          d.indexes = { unavailable: marker(), extra: 1 };
          d.exclusionConstraints = [{ name: marker() }];
        }),
      }),
    ).toEqual([
      refusal("frame-key-unknown", "objects.tree", "answer", "/detail/indexes/extra", "extra"),
      missing("/detail/exclusionConstraints/0/definition", "definition"),
    ]);
    expect(tree({ detail: objectDetail((d) => (d.indexes = "none")) })).toEqual([unreadable("/detail/indexes")]);
    expect(
      tree({ detail: objectDetail((d) => (d.indexes = [{ name: marker(), columns: [1], unique: true }])) }),
    ).toEqual([unreadable("/detail/indexes/0/columns/0")]);
    expect(tree({ detail: objectDetail((d) => delete d.foreignKeys) })).toEqual([
      missing("/detail/foreignKeys", "foreignKeys"),
    ]);
    expect(tree({ truncated: { limit: 1, reason: marker() } })).toEqual([missing("/details", "details")]);
    expect(tree({ details: [objectDetail()], truncated: { limit: "1" } })).toEqual([
      unreadable("/truncated/limit"),
      missing("/truncated/reason", "reason"),
    ]);
    expect(reads).toBe(0);
  });

  test("a connection's keys are the contract's field names and each value a connection field value", () => {
    const fieldNames = SCHEMA.$defs.fieldName?.enum ?? [];
    const connection = (value: Json) =>
      readFrame(
        "open",
        "context",
        openContext((c) => (c.connection = value)),
      );
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "open", "context", pointer);

    expect(fieldNames).toHaveLength(35);
    expect(connection(Object.fromEntries(fieldNames.map((name) => [name, marker()])))).toEqual([]);
    expect(connection({ host: marker(), port: 1, allowInsecureAuth: true, namespaces: [marker(), marker()] })).toEqual(
      [],
    );
    expect(connection({ notAField: marker() })).toEqual([
      refusal("frame-key-unknown", "open", "context", "/connection/notAField", "notAField"),
    ]);
    expect(connection({ host: null, port: { value: 1 }, namespaces: [1], database: [[marker()]] })).toEqual([
      unreadable("/connection/host"),
      unreadable("/connection/port"),
      unreadable("/connection/namespaces/0"),
      unreadable("/connection/database/0"),
    ]);
  });

  test("no frame refusal and no sentence carries a value of the frame", () => {
    const planted = [marker(), marker(), marker(), marker()];
    const refusals = [
      ...readFrame(
        "open",
        "context",
        openContext((c) => {
          c.tls.mode = planted[0];
          c.connection.port = { [marker()]: planted[1] };
          c.unknown = planted[2];
          c.engine = [planted[3]];
        }),
      ),
      ...readFrame("console.endScope", "answer", { openTransaction: planted[0] }),
      ...readFrame("console.transaction", "request", { action: planted[1] }),
      ...readFrame("console.transaction", "answer", { sessionState: planted[2], stateReported: planted[3] }),
    ];
    const text = JSON.stringify(refusals) + new FrameRefusalError(refusals).message;

    expect(refusals.length).toBe(8);
    for (const value of planted) expect(text).not.toContain(value);
  });
});

describe("frameRefusalSentence", () => {
  test("every frame refusal rule is worded in one sentence", () => {
    for (const rule of FRAME_REFUSAL_RULES) {
      for (const call of SERVED_CALLS) {
        const forms: FrameRefusal[] = [
          { rule, call, part: "answer", pointer: "" },
          { rule, call, part: "request", pointer: "/a\nb", name: 'a"\nb' },
        ];
        for (const item of forms) {
          const sentence = frameRefusalSentence(item);

          expect(sentence).toMatch(/^[A-Z][^\n]*\.$/);
          expect(sentence).not.toMatch(/\. [A-Z]/);
          expect(sentence).toContain(call);
        }
        expect(frameRefusalSentence(forms[0])).toContain("the top level");
        expect(frameRefusalSentence(forms[1])).toContain('"/a\\nb"');
      }
    }
  });

  test("a FrameRefusalError carries every refusal and words each", () => {
    const refusals = readFrame(
      "open",
      "context",
      openContext((c) => {
        delete c.egress;
        c.extra = 1;
      }),
    );
    const error = new FrameRefusalError(refusals);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FrameRefusalError");
    expect(error.refusals).toEqual([
      refusal("frame-key-unknown", "open", "context", "/extra", "extra"),
      refusal("frame-key-missing", "open", "context", "/egress", "egress"),
    ]);
    expect(error.refusals).not.toBe(refusals);
    expect(Object.isFrozen(error.refusals)).toBe(true);
    expect(error.message).toBe(refusals.map(frameRefusalSentence).join(" "));
    expect(frameRefusalSentence(error.refusals[0] as FrameRefusal)).toBe(
      'The key "extra" at "/extra" of the context of the open frame is one its shape does not define.',
    );
  });
});
