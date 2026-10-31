/**
 * The OPC UA provider, end to end over a recorded server (#1677).
 *
 * THE RECORDING IS A SERVER'S OWN WORDS. Every answer replayed here was captured from Microsoft OPC
 * PLC 2.15.10, pinned by digest, by `tests/live/opcua-evidence.ts`, which drives this provider's own
 * library bridge against it (`tests/fixtures/opcua/README.md` lists each file and the command that
 * wrote it). The replay opens no socket, so it is deterministic and needs no plant in CI, and
 * `mock.module()` is not used: the provider is handed a session opener, which is what that
 * constructor parameter is for.
 *
 * WHAT RUNS IS EVERYTHING ABOVE THE SOCKET: the connection reading and its refusals, the session
 * pool, the eight-service seam, the read request parser, the chunking, the level walk by escaped
 * browse path, the Source document, the history paging and the error table. What does not run is the
 * library's own encoder, which `tests/unit/db/opcua/library.test.ts` covers against the library's
 * own objects.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type {
  OpcuaBrowseResult,
  OpcuaDataValue,
  OpcuaEndpoint,
  OpcuaHistoryPage,
  OpcuaReadOnlyClient,
  OpcuaServerLimits,
} from "@/lib/db/providers/industrial/opcua/client";
import { OpcuaProvider } from "@/lib/db/providers/industrial/opcua/index";
import type { DatabaseConnection } from "@/lib/types";

const CAPTURES = join(import.meta.dir, "..", "..", "fixtures", "opcua");

/** Bytes come back from JSON as `{"@bytes": "<base64>"}`, which is how the capture wrote them. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["@bytes"] === "string") return new Uint8Array(Buffer.from(record["@bytes"], "base64"));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = revive(entry);
    return out;
  }
  return value;
}

function capture<T>(name: string): T {
  const body = JSON.parse(readFileSync(join(CAPTURES, `${name}.json`), "utf8")) as unknown;
  return revive(body) as T;
}

const ENDPOINTS = capture<{ endpoints: OpcuaEndpoint[] }>("endpoints");
const LIMITS = capture<OpcuaServerLimits>("limits");
const LEVELS = capture<Record<string, OpcuaBrowseResult>>("levels");
const VALUES = capture<{ nodeIds: string[]; values: OpcuaDataValue[] }>("values");
const HISTORY = capture<{
  nodeId: string;
  page: OpcuaHistoryPage;
  next?: OpcuaHistoryPage;
  mismatchedWindow?: OpcuaHistoryPage;
  unhistorized: { nodeId: string; page: OpcuaHistoryPage };
}>("history");

/** What the replay recorded about the calls the provider made, so the test can assert them. */
interface Calls {
  browse: string[][];
  read: string[][];
  history: { nodeId: string; startTime?: Date; endTime?: Date; valuesPerPage: number }[];
  continued: { startTime?: Date; endTime?: Date }[];
  released: number;
  closed: number;
}

function recordedClient(calls: Calls): OpcuaReadOnlyClient {
  let historyPages = 0;
  return {
    endpoints: async () => ENDPOINTS.endpoints,
    limits: async () => LIMITS,
    browse: async (nodeIds) => {
      calls.browse.push([...nodeIds]);
      return nodeIds.map((nodeId) => {
        const answer = LEVELS[nodeId];
        // A node the capture never browsed is a hole in the fixture, not an empty folder.
        if (answer === undefined) throw new Error(`no browse capture for ${nodeId}`);
        return answer;
      });
    },
    browseNext: async () => [],
    releaseBrowseContinuationPoints: async () => {
      calls.released += 1;
    },
    read: async (nodeIds) => {
      calls.read.push([...nodeIds]);
      return nodeIds.map((nodeId) => {
        const value = VALUES.values.find((entry) => entry.nodeId === nodeId);
        if (value === undefined) throw new Error(`no read capture for ${nodeId}`);
        return value;
      });
    },
    historyRead: async (options) => {
      calls.history.push({ ...options });
      historyPages = 1;
      if (options.nodeId === HISTORY.unhistorized.nodeId) return HISTORY.unhistorized.page;
      return HISTORY.page;
    },
    historyReadNext: async (options) => {
      calls.continued.push({ startTime: options.startTime, endTime: options.endTime });
      historyPages += 1;
      // The capture holds one continuation; after it the server had no more in this window.
      if (historyPages === 2 && HISTORY.next !== undefined) return HISTORY.next;
      return { nodeId: options.nodeId, values: [], statusCode: "Good" };
    },
    releaseHistoryContinuationPoint: async () => {
      calls.released += 1;
    },
    close: async () => {
      calls.closed += 1;
    },
  };
}

const fresh = (): Calls => ({ browse: [], read: [], history: [], continued: [], released: 0, closed: 0 });

function connection(over: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "opcua-replay",
    name: "OPC PLC",
    type: "opcua",
    host: "opc.tcp://127.0.0.1:54840/",
    sslMode: "None",
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    ...over,
  } as DatabaseConnection;
}

/** A provider over the recording, with the PKI root the connection reader requires. */
async function connected(calls: Calls, over: Partial<DatabaseConnection> = {}): Promise<OpcuaProvider> {
  const provider = new OpcuaProvider(connection(over), {}, {}, async () => recordedClient(calls), {
    LIBREDB_OPCUA_PKI_ROOT: "/tmp/libredb-opcua-pki",
  });
  await provider.connect();
  return provider;
}

describe("the capture is the fixture's own answer", () => {
  test("the endpoints are the seven OPC PLC offers, and the advertised URL is not the typed one", () => {
    expect(ENDPOINTS.endpoints.length).toBe(7);
    const modes = [...new Set(ENDPOINTS.endpoints.map((endpoint) => endpoint.securityMode))].sort();
    expect(modes).toEqual(["None", "Sign", "SignAndEncrypt"]);
    // O-S7, measured again in the capture: the server advertises a container hostname.
    for (const endpoint of ENDPOINTS.endpoints) {
      expect(endpoint.advertisedUrl).not.toContain("127.0.0.1");
      expect(endpoint.serverCertificateThumbprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /*
   * THE FIXTURE CHECKS ITSELF, because it carries the certificate the thumbprint is of. A shape
   * check alone (64 hex) would pass against a value somebody typed, and these seven were rewritten
   * once already when the pin moved from SHA-1 to SHA-256. Read as raw JSON rather than through
   * `OpcuaEndpoint`, which carries the thumbprint and not the DER it came from.
   */
  test("each recorded thumbprint is the SHA-256 of the certificate recorded beside it", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/opcua/endpoints.json"), "utf8")) as {
      endpoints: { serverCertificate: { "@bytes": string }; serverCertificateThumbprint: string }[];
    };
    expect(raw.endpoints.length).toBe(7);
    for (const endpoint of raw.endpoints) {
      const der = Buffer.from(endpoint.serverCertificate["@bytes"], "base64");
      expect(createHash("sha256").update(der).digest("hex")).toBe(endpoint.serverCertificateThumbprint);
    }
  });

  test("the published limits are the ones the provider's bounds were set against", () => {
    expect(LIMITS).toEqual({
      maxNodesPerRead: 2_500,
      maxNodesPerBrowse: 2_500,
      maxNodesPerHistoryReadData: 1_000,
      maxBrowseContinuationPoints: 10,
      maxHistoryContinuationPoints: 100,
    });
  });

  /**
   * THE MEASUREMENT THE READ-ONLY GUARANTEE EXISTS FOR. An anonymous session was told it may write.
   */
  test("an anonymous session was granted write on the seeded nodes", () => {
    const slow = VALUES.values.find((entry) => entry.nodeId === "ns=3;s=SlowUInt1");
    expect(slow?.accessLevel).toBe(3);
    expect(slow?.userAccessLevel).toBe(3);
  });
});

describe("a value read, end to end", () => {
  test("one request answers one row per node, in the order the request named them", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const result = await provider.query('{ "read": ["ns=3;s=FastUInt1", "ns=3;s=SlowUInt1"] }');
    expect(result.fields).toEqual(["nodeId", "value", "shape", "statusCode", "sourceTimestamp", "serverTimestamp"]);
    expect(result.rows.map((row) => row.nodeId)).toEqual(["ns=3;s=FastUInt1", "ns=3;s=SlowUInt1"]);
    expect(result.rows[0]?.statusCode).toBe("Good");
    expect(result.rows[0]?.shape).toBe("number");
    await provider.disconnect();
    expect(calls.closed).toBe(1);
  });

  test("a node the server does not hold keeps its row and the server's own code", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const result = await provider.query('{ "read": ["ns=3;s=NoSuchNodeAtAll"] }');
    expect(result.rows).toHaveLength(1);
    // Whatever OPC PLC answered for a node it does not hold, as it answered it.
    expect(String(result.rows[0]?.statusCode)).toMatch(/^Bad/);
    await provider.disconnect();
  });

  test("a request that is not a read request is refused before anything is sent", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.query('{ "write": ["ns=3;s=SlowUInt1"] }')).rejects.toThrow(/names "write"/);
    expect(calls.read).toEqual([]);
    await provider.disconnect();
  });
});

describe("the Keys panel walks the address space", () => {
  test("the first page is the Objects folder's own children, as the server listed them", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    /*
     * THE REQUEST THE PANEL REALLY SENDS: `level: true`, `cursor: "0"`, and NO pattern for the
     * root. Every test in this block passed `cursor: ""` and `pattern: ""`, and the route refuses
     * both - it defaults an absent cursor to `"0"` and rejects an empty pattern before the provider
     * ever sees it. Proving the provider against a request the panel cannot send is how a level
     * that never reported itself finished passed this suite twice.
     */
    const page = await provider.scanKeysPage({ cursor: "0", count: 200, level: true });
    expect(calls.browse[0]).toEqual(["i=85"]);
    const entries = [...page.keys, ...(page.prefixes ?? [])];
    expect(entries.length).toBeGreaterThan(3);
    // Both hold children on the fixture, so both are folders the reader can open.
    expect(page.prefixes).toContain("Server/");
    expect(page.prefixes).toContain("OpcPlc/");
    // A server publishes no count of its nodes, so the page carries none.
    expect(page.total).toBe(0);
    await provider.disconnect();
  });

  test("a level is addressed by its path, re-browsed from the Objects folder", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const page = await provider.scanKeysPage({ cursor: "0", count: 200, pattern: "Server/", level: true });
    // One Browse to resolve `Server`, then one for its own level, then the folder measurement round.
    expect(calls.browse.length).toBeGreaterThanOrEqual(3);
    const entries = [...page.keys, ...(page.prefixes ?? [])];
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) expect(entry.startsWith("Server/")).toBe(true);
    // `ServerStatus` holds children on the fixture, so it is a folder rather than a key.
    expect(page.prefixes).toContain("Server/ServerStatus/");
    await provider.disconnect();
  });

  test("a path that names nothing is a refusal, not an empty folder", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    await expect(
      provider.scanKeysPage({ cursor: "0", count: 200, pattern: "NotAFolder/", level: true }),
    ).rejects.toThrow(/No node named NotAFolder/);
    await provider.disconnect();
  });

  test("a method row is listed and is not a folder", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const page = await provider.scanKeysPage({ cursor: "0", count: 200, pattern: "Server/", level: true });
    const methods = Object.entries(page.types).filter(([, kind]) => kind === "method");
    expect(methods.length).toBeGreaterThan(0);
    // A method is a key with its own class, and never a folder prefix: it is listed, never browsed.
    for (const [key] of methods) expect(page.prefixes ?? []).not.toContain(`${key}/`);
    await provider.disconnect();
  });
});

describe("a node's Source document", () => {
  test("one part, the node's own attributes, rendered and not offered for edit", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const document = await provider.readObjectSource(["OpcPlc", "Telemetry", "Slow", "SlowUInt1"], "node");
    const [part] = document.parts;
    expect(part?.id).toBe("node");
    // The readable arm of the union, which is what narrows `text` into existence: a refusal arm
    // declares none, so this assertion is also the proof that the document carries a definition.
    if (part === undefined || !("text" in part)) throw new Error("the node part carries no text");
    expect(part.language).toBe("json");
    expect(part.origin).toBe("rendered");
    expect(part.form).toBe("complete");
    const edit = part.edit;
    if (edit === undefined || edit.offered !== false) throw new Error("the node part offers an edit");
    expect(edit.reason).toContain("no code that can write");
    const body = JSON.parse(part.text) as Record<string, unknown>;
    expect(body.nodeId).toBe("ns=3;s=SlowUInt1");
    // The server's own word for the node, and its AccessLevel in words rather than as bits.
    expect(body.nodeClass).toBe("Variable");
    expect(body.accessLevel).toBe("read, write");
    expect(body.historizing).toBe(false);
    await provider.disconnect();
  });

  test("a kind this provider does not have is refused", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    await expect(provider.readObjectSource(["Server"], "table")).rejects.toBeInstanceOf(DatabaseConfigError);
    await provider.disconnect();
  });
});

describe("raw history", () => {
  test("a page, a continuation carrying the same window, and the reason it stopped", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const result = await provider.query(`{ "history": "${HISTORY.nodeId}", "limit": 40 }`);
    expect(result.rows.length).toBe(HISTORY.page.values.length + (HISTORY.next?.values.length ?? 0));
    expect(result.fields).toContain("sourceTimestamp");
    /*
     * A RESULT WITH ROWS CARRIES THE SENTENCE TOO, and that is the half a test of the empty case
     * cannot see: a read stopped by the ten-thousand cap has rows AND a reason, and dropping the
     * reason there loses a truncation warning in silence. Measured as a mutation: removing the
     * warning from this branch alone passed every other test in the suite.
     */
    expect(result.warnings?.[0]?.message).toMatch(/value|window|history/i);
    // The window the first read sent is the window every continuation sent.
    const first = calls.history[0];
    expect(first?.startTime).toBeDefined();
    for (const continued of calls.continued) {
      expect(continued.startTime?.getTime()).toBe(first?.startTime?.getTime());
      expect(continued.endTime?.getTime()).toBe(first?.endTime?.getTime());
    }
    await provider.disconnect();
  });

  /**
   * The trap, as the server words it: a continuation whose details differ from the read that handed
   * out the point is refused, so the window is fixed once and travels with every page.
   */
  test("the capture holds the refusal a mismatched window earns", () => {
    expect(HISTORY.mismatchedWindow?.statusCode).toBe("BadContinuationPointInvalid");
    expect(HISTORY.mismatchedWindow?.values).toEqual([]);
  });

  test("a node that keeps no history answers the server's own refusal, not an empty table", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const result = await provider.query(`{ "history": "${HISTORY.unhistorized.nodeId}", "limit": 10 }`);
    /*
     * Zero rows, AND the server's own sentence: an empty table with no word told a reader the
     * window held nothing when the truth was that the node keeps no history at all.
     *
     * READ OFF `warnings` WITH NO CAST, which is the point of these three lines. The sentence used
     * to be a `notice` field cast onto the result, and a cast is what let it be written to a field
     * no surface reads: asserted through the same cast, the test agreed with the provider and the
     * grid stayed silent. `warnings` is a declared field of `QueryResult`, so this assertion is
     * about the channel `StatsBar` really draws.
     */
    expect(result.rows).toEqual([]);
    expect(HISTORY.unhistorized.page.statusCode).toBe("BadHistoryOperationUnsupported");
    expect(result.warnings?.[0]?.message).toContain("BadHistoryOperationUnsupported");
    expect(result.warnings?.[0]?.message).toContain("that node keeps no history");
    // The code travels in the field it belongs in, as well as in the sentence.
    expect(result.warnings?.[0]?.code).toBe("BadHistoryOperationUnsupported");
    await provider.disconnect();
  });
});

describe("the surfaces a server does not have", () => {
  test("nodes are listed in the Keys panel, and the object tree says so", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    await expect(provider.listObjects()).rejects.toThrow(/Keys panel/);
    expect(await provider.listContainers()).toEqual([]);
    expect(await provider.countObjects()).toEqual({});
    await provider.disconnect();
  });

  test("maintenance would be a write, and the refusal says the client has eight read services", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    await expect(provider.runMaintenance("vacuum")).rejects.toThrow(/eight read services/);
    await provider.disconnect();
  });

  test("a figure the server does not publish is unknown, never zero", async () => {
    const calls = fresh();
    const provider = await connected(calls);
    const overview = await provider.getOverview();
    expect(overview.version).toBe("unknown");
    expect(overview.uptime).toBe("unknown");
    const health = await provider.getHealth();
    expect(health.cacheHitRatio).toBe("unknown");
    expect(await provider.getActiveSessions()).toEqual([]);
    await provider.disconnect();
  });
});

describe("the connection's refusals happen before a socket exists", () => {
  test("a password with no username names no identity", async () => {
    const provider = new OpcuaProvider(
      connection({ password: "secret" }),
      {},
      {},
      async () => recordedClient(fresh()),
      {
        LIBREDB_OPCUA_PKI_ROOT: "/tmp/libredb-opcua-pki",
      },
    );
    await expect(provider.connect()).rejects.toThrow(/password with no username/);
  });

  /**
   * NO VARIABLE IS STUDIO'S OWN DATA DIRECTORY, not a refusal. The LIBRARY's default still cannot be
   * used - the image's home is `/nonexistent` - but refusing meant the engine could not be connected
   * at all in a default install, which a browser run measured: Test Connection answered "An OPC UA
   * connection needs a PKI directory" and the reader had no way to know what to set. A RELATIVE
   * variable is still refused, because it resolves against whatever directory the server started in.
   */
  test("no PKI variable connects on Studio's own data directory, and a relative one is refused", async () => {
    const record = fresh();
    const provider = new OpcuaProvider(connection(), {}, {}, async () => recordedClient(record), {});
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();

    const relative = new OpcuaProvider(connection(), {}, {}, async () => recordedClient(fresh()), {
      LIBREDB_OPCUA_PKI_ROOT: "pki",
    });
    await expect(relative.connect()).rejects.toThrow(/absolute path/);
  });

  test("an endpoint in another scheme is refused", async () => {
    const provider = new OpcuaProvider(
      connection({ host: "https://plc.example.net:4840/" }),
      {},
      {},
      async () => recordedClient(fresh()),
      { LIBREDB_OPCUA_PKI_ROOT: "/tmp/libredb-opcua-pki" },
    );
    await expect(provider.connect()).rejects.toThrow(/opc.tcp:\/\/ only/);
  });

  test("a build with no transport says so rather than failing obscurely", async () => {
    const provider = new OpcuaProvider(connection(), {}, {}, undefined, {
      LIBREDB_OPCUA_PKI_ROOT: "/tmp/libredb-opcua-pki",
    });
    await expect(provider.connect()).rejects.toBeInstanceOf(QueryError);
  });
});
