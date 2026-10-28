/**
 * The provider's own surface: every declaration and every refusal (#1677 section 8).
 *
 * EVERY SURFACE A SERVER DOES NOT HAVE IS ASSERTED BY NAME, not left to a default. A panel that
 * drew an empty table where there is no table, or offered maintenance against a connection that
 * cannot write, would be lying by omission.
 */
import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type {
  OpcuaDataValue,
  OpcuaNodeId,
  OpcuaReadOnlyClient,
  OpcuaReference,
} from "@/lib/db/providers/industrial/opcua/client";
import { OpcuaProvider } from "@/lib/db/providers/industrial/opcua/index";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import type { DatabaseConnection } from "@/lib/types";

const ENV = { [OPCUA_PKI_ROOT_ENV]: "/app/data/opcua-pki" } as const;

function connection(over: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "o",
    name: "o",
    type: "opcua",
    host: "opc.tcp://127.0.0.1:54840/",
    ...over,
  } as never;
}

function child(name: string, mayHaveChildren = false): OpcuaReference {
  return {
    nodeId: `ns=3;s=${name}`,
    browseName: name,
    displayName: name,
    nodeClass: mayHaveChildren ? "Object" : "Variable",
    referenceTypeId: "i=47",
    mayHaveChildren,
  };
}

/** A server whose address space and values a test states, and that records what was asked. */
function fakeServer(
  tree: Readonly<Record<string, readonly OpcuaReference[]>>,
  values: Readonly<Record<string, OpcuaDataValue>>,
  record: { readBatches: number[]; closed: number },
): OpcuaReadOnlyClient {
  return {
    endpoints: async () => [],
    limits: async () => ({ maxNodesPerRead: 2_500 }),
    browse: async (nodeIds: readonly OpcuaNodeId[]) =>
      nodeIds.map((nodeId) => ({
        nodeId,
        references: tree[nodeId] ?? [],
        statusCode: "Good",
      })),
    browseNext: async () => [],
    releaseBrowseContinuationPoints: async () => {},
    read: async (nodeIds: readonly OpcuaNodeId[]) => {
      record.readBatches.push(nodeIds.length);
      return nodeIds.map(
        (nodeId) =>
          values[nodeId] ?? {
            nodeId,
            value: null,
            statusCode: "BadNodeIdUnknown",
          },
      );
    },
    historyRead: async () => ({ nodeId: "", values: [], statusCode: "Good" }),
    historyReadNext: async () => ({
      nodeId: "",
      values: [],
      statusCode: "Good",
    }),
    releaseHistoryContinuationPoint: async () => {},
    close: async () => {
      record.closed += 1;
    },
  };
}

const fresh = () => ({ readBatches: [] as number[], closed: 0 });

async function open(
  over: Record<string, unknown> = {},
  tree: Readonly<Record<string, readonly OpcuaReference[]>> = {},
  values: Readonly<Record<string, OpcuaDataValue>> = {},
  record = fresh(),
): Promise<{ provider: OpcuaProvider; record: ReturnType<typeof fresh> }> {
  const provider = new OpcuaProvider(connection(over), {}, async () => fakeServer(tree, values, record), ENV);
  await provider.connect();
  return { provider, record };
}

describe("the declarations", () => {
  const provider = new OpcuaProvider(connection(), {}, undefined, ENV);

  test("read-only is declared true, and it is structural rather than a setting", () => {
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
  });

  test("its own dialect, so a connection never falls through to another engine's tab", () => {
    expect(provider.getCapabilities().queryDialect).toBe("opcua");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
  });

  test("the IANA port", () => {
    expect(provider.getCapabilities().defaultPort).toBe(4840);
  });

  test("no second page, no transaction, no schema", () => {
    const capabilities = provider.getCapabilities();
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(capabilities.supportsTransactions).toBe(false);
    expect(capabilities.declaresForeignKeys).toBe(false);
    expect(capabilities.createTable).toBeUndefined();
    expect(capabilities.supportsInlineRowEdit).toBe(false);
  });

  test("the labels name a node and a value, and say why three actions are absent", () => {
    const labels = provider.getLabels();
    expect(labels.entityName).toBe("Node");
    expect(labels.rowName).toBe("Value");
    expect(labels.vacuumGlobalDesc).toMatch(/no code that can write/);
  });
});

describe("connecting", () => {
  test("a connection is read before anything is dialled, so a bad one never opens a socket", async () => {
    const provider = new OpcuaProvider(
      connection({ host: "http://plc/" }),
      {},
      async () => {
        throw new Error("should not have been reached");
      },
      ENV,
    );
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    expect(provider.isConnected()).toBe(false);
  });

  /**
   * NO PKI VARIABLE REACHES THE DIAL NOW, with Studio's own data directory as the root: refusing
   * here is what made the engine unusable until a reader found an environment variable, which a
   * browser run measured. A RELATIVE variable is still refused before the dial, which is the half
   * that has to stay - a relative root resolves against whatever directory the server started in.
   */
  test("no PKI variable reaches the dial, and a relative one is refused before it", async () => {
    const reached: string[] = [];
    const withoutVariable = new OpcuaProvider(
      connection(),
      {},
      async (options) => {
        reached.push(options.pkiRoot);
        throw new Error("BadConnectionClosed");
      },
      {},
    );
    await expect(withoutVariable.connect()).rejects.toThrow(/BadConnectionClosed|connection closed/);
    expect(reached).toHaveLength(1);
    expect(isAbsolute(reached[0] ?? "")).toBe(true);

    const relative = new OpcuaProvider(
      connection(),
      {},
      async () => {
        throw new Error("should not have been reached");
      },
      { [OPCUA_PKI_ROOT_ENV]: "pki" },
    );
    await expect(relative.connect()).rejects.toThrow(/absolute path/);
  });

  test("disconnect closes the session, and once", async () => {
    const { provider, record } = await open();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
    await provider.disconnect();
    expect(record.closed).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });
});

describe("the read console", () => {
  test("empty text says what a request looks like rather than failing silently", async () => {
    const { provider } = await open();
    await expect(provider.query("   ")).rejects.toThrow(/nothing to run/);
    await expect(provider.query("")).rejects.toThrow(/"read"/);
  });

  test("a value read answers one row per node named, in that order", async () => {
    const { provider } = await open(
      {},
      {},
      {
        "ns=3;s=A": { nodeId: "ns=3;s=A", value: 1, statusCode: "Good" },
        "ns=3;s=B": { nodeId: "ns=3;s=B", value: 2, statusCode: "Good" },
      },
    );
    const result = await provider.query('{"read":["ns=3;s=B","ns=3;s=A"]}');
    expect(result.rows.map((row) => row.nodeId)).toEqual(["ns=3;s=B", "ns=3;s=A"]);
  });

  /** A node the server refuses is a row with its status, not a dropped row. */
  test("a node the server does not know is still a row", async () => {
    const { provider } = await open();
    const result = await provider.query('{"read":["ns=3;s=Missing"]}');
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.statusCode).toBe("BadNodeIdUnknown");
  });

  /** Chunked by our own bound: two of four servers measured do not enforce their published one. */
  test("a long read is chunked by our own bound, not the server's", async () => {
    const ids = Array.from({ length: 600 }, (_, at) => `ns=3;s=N${at}`);
    const { provider, record } = await open({}, {}, {});
    await provider.query(JSON.stringify({ read: ids }));
    expect(record.readBatches.every((size) => size <= 250)).toBe(true);
    expect(record.readBatches.reduce((sum, size) => sum + size, 0)).toBe(600);
  });

  test("a history read of a node with no history answers an empty table that still has columns", async () => {
    const { provider } = await open();
    const result = await provider.query('{"history":"ns=3;s=H","limit":10}');
    expect(result.rowCount).toBe(0);
    expect(result.fields.length).toBeGreaterThan(0);
  });
});

describe("the Keys panel", () => {
  const tree = {
    "i=85": [child("OpcPlc", true), child("Server", true)],
    "ns=3;s=OpcPlc": [child("SlowUInt1"), child("Telemetry", true)],
    // `Telemetry` really holds something, so the measurement round answers children for it; `Server`
    // deliberately holds nothing, which is how a row that LOOKS like a folder becomes a leaf.
    "ns=3;s=Telemetry": [child("Basic", true)],
  };

  test("the first level is the Objects folder's children", async () => {
    const { provider } = await open({}, tree);
    /*
     * THE REQUEST THE PANEL REALLY SENDS: `level: true`, `cursor: "0"`, and no pattern at the root.
     * The route defaults an absent cursor to `"0"` and refuses an empty one, so `""` was a request
     * nothing in the product can make - which is how a level whose cursor never said it had
     * finished passed this file.
     */
    const page = await provider.scanKeysPage({
      cursor: "0",
      count: 100,
      level: true,
    });
    // Folders are prefixes, and the flag is MEASURED: `OpcPlc` answered children, `Server` did not,
    // so one is expandable and the other is a leaf whatever its node class says.
    expect(page.prefixes).toEqual(["OpcPlc/"]);
    expect(page.keys).toEqual(["Server"]);
  });

  test("a deeper level is resolved by walking down the path", async () => {
    const { provider } = await open({}, tree);
    const page = await provider.scanKeysPage({
      cursor: "0",
      count: 100,
      pattern: "OpcPlc/",
      level: true,
    });
    expect(page.keys).toEqual(["OpcPlc/SlowUInt1"]);
    expect(page.prefixes).toEqual(["OpcPlc/Telemetry/"]);
    expect(page.types["OpcPlc/SlowUInt1"]).toBe("variable");
  });

  /**
   * THE LEVEL ENDS IN `"0"`, THROUGH THE PROVIDER AND NOT ONLY THROUGH `levelPage`. The panel reads
   * `page.cursor === "0"` and nothing else as the end of a walk, so this is the assertion that
   * stands between a working Keys panel and one whose List more button never goes away.
   */
  test("a level that fits in one page reports itself finished, in the panel's own word", async () => {
    const { provider } = await open({}, tree);
    const page = await provider.scanKeysPage({
      cursor: "0",
      count: 100,
      level: true,
    });
    expect(page.cursor).toBe("0");
  });

  test("a level longer than one page is paged by the cursor it answered, to its end", async () => {
    const { provider } = await open({}, tree);
    const first = await provider.scanKeysPage({
      cursor: "0",
      count: 1,
      level: true,
    });
    expect(first.prefixes).toEqual(["OpcPlc/"]);
    expect(first.cursor).toBe("after:OpcPlc");
    const second = await provider.scanKeysPage({
      cursor: first.cursor,
      count: 1,
      level: true,
    });
    expect(second.keys).toEqual(["Server"]);
    expect(second.cursor).toBe("0");
  });

  /** The filter box sends its text as the prefix, with no separator on the end. */
  test("a pattern with no trailing separator filters the level above it rather than breaking the route", async () => {
    const { provider } = await open({}, tree);
    const page = await provider.scanKeysPage({
      cursor: "0",
      count: 100,
      pattern: "Opc",
      level: true,
    });
    expect(page.prefixes).toEqual(["OpcPlc/"]);
    expect(page.keys).toEqual([]);
    // The route's own rule over the raw pattern, which a level outside it answers HTTP 500 for.
    for (const entry of [...page.keys, ...(page.prefixes ?? [])]) {
      expect(entry.startsWith("Opc")).toBe(true);
      expect(entry.slice("Opc".length).replace(/\/$/, "")).not.toContain("/");
    }
  });

  test("a path that names nothing is a config error, not an empty level", async () => {
    const { provider } = await open({}, tree);
    await expect(
      provider.scanKeysPage({
        cursor: "0",
        count: 10,
        pattern: "Nope/",
        level: true,
      }),
    ).rejects.toThrow(DatabaseConfigError);
  });

  test("a page names no database, because one connection is one endpoint", async () => {
    const { provider } = await open({}, tree);
    await expect(
      provider.scanKeysPage({
        cursor: "0",
        count: 10,
        database: 0,
        level: true,
      }),
    ).rejects.toThrow(/no database/);
  });

  /**
   * A WALK OF THE WHOLE KEY SPACE IS REFUSED, and that is the same decision as the bounded walk: an
   * address space is a graph with more paths than nodes and no cursor a server will resume, so one
   * level at a time is the only listing this provider can stand behind. The panel always asks for a
   * level, so nothing in the product meets this refusal.
   */
  test("a request without level is refused, because there is no whole-space walk", async () => {
    const { provider } = await open({}, tree);
    await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.toThrow(/one level at a time/);
    await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.toBeInstanceOf(DatabaseConfigError);
  });
});

/**
 * THE SERVER'S OWN LIMITS HAVE TO REACH THE CHUNKERS, and nothing asserted that they did.
 *
 * `limits.ts` exists to keep a request inside the operation limit a server enforces, and its only
 * production consumers are two lines in this provider: the read path and the folder measurement.
 * Both could be handed `{}` instead of the server's answer and all 412 OPC UA tests stayed green -
 * found as a surviving mutation. The cost is real on the servers the module was written for: a
 * small embedded server or a PLC that publishes a limit below Studio's own bound answers
 * `BadTooManyOperations` and the whole read fails.
 *
 * The live fixture cannot catch it (it publishes 2,500 for both, which is above Studio's bound, so
 * chunking by `{}` and chunking by the server's answer are the same request), which is exactly why
 * these two tests state a server that publishes less.
 */
describe("a server that publishes a limit below Studio's own bound", () => {
  const WIDE = Array.from({ length: 9 }, (_, at) => `ns=3;s=N${at}`);

  /** A server that publishes small limits and records the batch sizes it was asked in. */
  function tightServer(
    limits: {
      readonly maxNodesPerRead?: number;
      readonly maxNodesPerBrowse?: number;
    },
    record: { readBatches: number[]; browseBatches: number[] },
  ): OpcuaReadOnlyClient {
    const level = Array.from({ length: 7 }, (_, at) => child(`F${at}`, true));
    return {
      endpoints: async () => [],
      limits: async () => limits,
      browse: async (nodeIds: readonly OpcuaNodeId[]) => {
        record.browseBatches.push(nodeIds.length);
        return nodeIds.map((nodeId) => ({
          nodeId,
          // The Objects folder answers the level; every child answers one child of its own, so
          // every row of the level is a folder and every row is asked about.
          references: nodeId === "i=85" ? level : [child("leaf")],
          statusCode: "Good",
        }));
      },
      browseNext: async () => [],
      releaseBrowseContinuationPoints: async () => {},
      read: async (nodeIds: readonly OpcuaNodeId[]) => {
        record.readBatches.push(nodeIds.length);
        return nodeIds.map((nodeId) => ({
          nodeId,
          value: 1,
          statusCode: "Good",
        }));
      },
      historyRead: async () => ({ nodeId: "", values: [], statusCode: "Good" }),
      historyReadNext: async () => ({
        nodeId: "",
        values: [],
        statusCode: "Good",
      }),
      releaseHistoryContinuationPoint: async () => {},
      close: async () => {},
    };
  }

  test("a read is chunked to the server's maxNodesPerRead, not to Studio's bound", async () => {
    const record = {
      readBatches: [] as number[],
      browseBatches: [] as number[],
    };
    const provider = new OpcuaProvider(connection(), {}, async () => tightServer({ maxNodesPerRead: 30 }, record), ENV);
    await provider.connect();
    const result = await provider.query(JSON.stringify({ read: WIDE }));
    expect(result.rows).toHaveLength(9);
    /*
     * Thirty OPERATIONS is three nodes, because one node costs ten of them: a Read takes
     * (node, attribute) pairs and this provider asks for the value and the nine attributes beside
     * it in one request (`OPCUA_READ_ATTRIBUTES`). So nine nodes are 3,3,3 - and `{}` would be one
     * request of nine, which is what the surviving mutation did.
     */
    expect(record.readBatches).toEqual([3, 3, 3]);
    await provider.disconnect();
  });

  test("the folder measurement is chunked to the server's maxNodesPerBrowse", async () => {
    const record = {
      readBatches: [] as number[],
      browseBatches: [] as number[],
    };
    const provider = new OpcuaProvider(
      connection(),
      {},
      async () => tightServer({ maxNodesPerBrowse: 3 }, record),
      ENV,
    );
    await provider.connect();
    const page = await provider.scanKeysPage?.({
      cursor: "0",
      count: 100,
      level: true,
    });
    expect(page?.prefixes).toHaveLength(7);
    // One browse for the level, then the seven rows measured three at a time: 3,3,1.
    expect(record.browseBatches).toEqual([1, 3, 3, 1]);
    await provider.disconnect();
  });

  /** The control: with no limit published, Studio's own bounds decide, and they are wider. */
  test("a server that publishes nothing is chunked by Studio's own bound", async () => {
    const record = {
      readBatches: [] as number[],
      browseBatches: [] as number[],
    };
    const provider = new OpcuaProvider(connection(), {}, async () => tightServer({}, record), ENV);
    await provider.connect();
    await provider.query(JSON.stringify({ read: WIDE }));
    expect(record.readBatches).toEqual([9]);
    await provider.scanKeysPage?.({ cursor: "0", count: 100, level: true });
    // 20 nodes per browse is Studio's own bound, so seven rows are one request.
    expect(record.browseBatches).toEqual([1, 7]);
    await provider.disconnect();
  });
});

/**
 * THE LIFECYCLE, AND THE TWO THINGS IT USED TO GET WRONG.
 *
 * `connect, disconnect, connect` on one instance was refused for ever: the session pool latches
 * closed on purpose, and nothing built a new one - so the refusal named the one call it had just
 * made impossible. The HTTP routes hid it (the factory builds a fresh provider when `isConnected()`
 * is false), but the published `DatabaseProvider` interface does not, and no other provider in the
 * tree is single-use.
 */
describe("the lifecycle", () => {
  test("a provider connects again after a disconnect, on a new session", async () => {
    const record = fresh();
    const { provider } = await open({}, {}, { "i=2258": { nodeId: "i=2258", value: 1, statusCode: "Good" } }, record);
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(record.closed).toBe(1);

    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    const result = await provider.query(JSON.stringify({ read: ["i=2258"] }));
    expect(result.rows).toHaveLength(1);
    await provider.disconnect();
    // Two sessions over the two connects, and both closed: nothing is left behind by the reconnect.
    expect(record.closed).toBe(2);
  });
});

/**
 * A PATH OF EMPTY STRINGS NAMES NO NODE, and it used to be answered as the Objects folder:
 * `pathSegments("")` is `[]` and `resolvePath(client, [])` is `i=85`, both correct on their own.
 * The route refuses an empty path ARRAY in its own words; this is the same refusal for the path
 * that survives it.
 */
describe("a path that names no node", () => {
  test.each([[[""]], [["", ""]], [["/"]]])("%j is refused rather than read as the Objects folder", async (path) => {
    const { provider } = await open({}, { "i=85": [child("OpcPlc", true)] });
    await expect(provider.readObjectSource(path, "node")).rejects.toThrow(/names no node/);
    await expect(provider.readObjectSource(path, "node")).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  test("a path that names one still reads it, which is the control", async () => {
    const { provider } = await open(
      {},
      { "i=85": [child("OpcPlc", true)] },
      {
        "ns=3;s=OpcPlc": {
          nodeId: "ns=3;s=OpcPlc",
          value: null,
          nodeClass: "Object",
          statusCode: "Good",
        },
      },
    );
    const document = await provider.readObjectSource(["OpcPlc"], "node");
    expect(document.parts).toHaveLength(1);
  });
});

describe("surfaces a server does not have", () => {
  test("no containers, because one connection is one endpoint", async () => {
    const { provider } = await open();
    expect(await provider.listContainers()).toEqual([]);
  });

  /** A server publishes no count, so none is invented. */
  test("no object counts", async () => {
    const { provider } = await open();
    expect(await provider.countObjects()).toEqual({});
  });

  test("the object tree says where nodes are listed instead", async () => {
    const { provider } = await open();
    await expect(provider.listObjects()).rejects.toThrow(/Keys panel/);
    await expect(provider.describeObject()).rejects.toThrow(/Keys panel/);
  });

  test("maintenance is refused with the reason, not merely disabled", async () => {
    const { provider } = await open();
    await expect(provider.runMaintenance("vacuum" as never)).rejects.toThrow(/no code that can write/);
  });

  test("health is honest about what it cannot read", async () => {
    const { provider } = await open();
    const health = await provider.getHealth();
    expect(health.cacheHitRatio).toBe("unknown");
    expect(health.slowQueries).toEqual([]);
  });

  test("no slow queries and no session list, because neither exists to read", async () => {
    const { provider } = await open();
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    // The table and index reads REFUSE rather than answer empty, for the reason the statistics
    // test below gives: a panel draws an empty array as a measurement of a server.
    await expect(provider.getTableStats()).rejects.toThrow(/nodes rather than tables/);
    await expect(provider.getIndexStats()).rejects.toThrow(/nodes rather than tables/);
  });
});

describe("a build with no transport wired in", () => {
  test("says so rather than failing as a network error", async () => {
    const provider = new OpcuaProvider(connection(), {}, undefined, ENV);
    await expect(provider.connect()).rejects.toThrow(QueryError);
    await expect(provider.connect()).rejects.toThrow(/no OPC UA transport/);
  });
});

/**
 * THE SURFACES A SERVER DOES NOT HAVE, each asserted by name rather than left to a default.
 *
 * `listObjects` and the two describe calls all refuse with the same sentence, because the Keys panel
 * is the only surface that browses an address space; the three statistics calls REFUSE as well,
 * because a panel draws an empty array as a measurement; and absence is never sent as a zero.
 */
describe("every surface a server does not have", () => {
  test("the object tree's three calls refuse, and each names the Keys panel", async () => {
    const { provider } = await open();
    await expect(provider.listObjects()).rejects.toThrow(/Keys panel/);
    await expect(provider.describeObject()).rejects.toThrow(/Keys panel/);
    await expect(provider.describeObjects()).rejects.toThrow(/Keys panel/);
    for (const call of [provider.listObjects(), provider.describeObject(), provider.describeObjects()]) {
      await expect(call).rejects.toBeInstanceOf(QueryError);
    }
    await provider.disconnect();
  });

  /*
   * THE PANELS WITH NO LABEL REFUSE; THE TWO WITH ONE ANSWER EMPTY. An empty array is drawn as a
   * measurement: a browser pass found the Tables panel reporting "0 tables, 0 rows, 0 B" and "No
   * tables found." against a server whose own tree lists nine root folders. The two CORE panels keep
   * their empty arrays - four rejections would be read as a dead connection - and say why through
   * `getLabels()`, which is the member ten other providers use for exactly this.
   */
  test("the three statistics calls refuse, naming what a server holds instead", async () => {
    const { provider } = await open();
    for (const call of [provider.getStorageStats(), provider.getTableStats(), provider.getIndexStats()]) {
      await expect(call).rejects.toThrow(/address space of nodes rather than tables/);
      await expect(call).rejects.toBeInstanceOf(QueryError);
    }
    await provider.disconnect();
  });

  test("slow queries and sessions answer empty, and the labels say why in this engine's words", async () => {
    const { provider } = await open();
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getPerformanceMetrics()).toEqual({});

    const labels = provider.getLabels();
    // The defaults are written for a SQL server: measured in a browser, the Queries panel told an
    // OPC UA reader to install `pg_stat_statements` and Sessions said "No active sessions found."
    expect(labels.slowQueriesEmptyState).toMatch(/keeps no query log/);
    expect(labels.sessionsEmptyState).toMatch(/session COUNT/);
    await provider.disconnect();
  });

  test("a Good ServerStatus fills the overview's version and uptime, and the size stays unknown", async () => {
    const status = {
      startTime: "2026-10-12T15:28:49.204Z",
      currentTime: "2026-10-12T19:06:57.320Z",
      buildInfo: { productName: "IoT Edge OPC UA PLC", softwareVersion: "2.15.10" },
    };
    const { provider } = await open({}, {}, { "i=2256": { nodeId: "i=2256", value: status, statusCode: "Good" } });
    const overview = await provider.getOverview();
    expect(overview.version).toBe("IoT Edge OPC UA PLC 2.15.10");
    expect(overview.uptime).not.toBe("unknown");
    expect(overview.databaseSize).toBe("unknown");
    await provider.disconnect();
  });

  /** A number a server does not publish is "unknown", and a session count is not a session list. */
  test("the health and overview reads name what is unknown", async () => {
    const { provider } = await open();
    const overview = await provider.getOverview();
    expect(overview.version).toBe("unknown");
    expect(overview.uptime).toBe("unknown");
    expect(overview.databaseSize).toBe("unknown");
    const health = await provider.getHealth();
    expect(health.databaseSize).toBe("unknown");
    expect(health.cacheHitRatio).toBe("unknown");
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    await provider.disconnect();
  });

  test("every maintenance operation refuses, and the refusal names the operation asked for", async () => {
    const { provider } = await open();
    for (const operation of ["vacuum", "analyze", "reindex"] as const) {
      await expect(provider.runMaintenance(operation)).rejects.toThrow(new RegExp(operation));
      await expect(provider.runMaintenance(operation)).rejects.toThrow(/eight read services/);
    }
    await provider.disconnect();
  });
});
