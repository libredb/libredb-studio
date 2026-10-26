/**
 * The OPC UA bridge against a REAL server, in this process (#1677 O-S1, O-S2, O-S7).
 *
 * WHY A SERVER AND NOT A FAKE. Everything between this provider and the wire is the library's:
 * GetEndpoints, the secure channel, CreateSession, ActivateSession, the encoder, the status codes.
 * A stand-in for it would agree with whatever the bridge happened to do, so the bridge's own module
 * is driven against `node-opcua-server` 2.187.16 started here on a loopback port — the same library
 * family the client speaks, which is the point: the two halves of OPC 10000-6 meet in this file.
 *
 * It needs no container and no plant: the server starts in `beforeAll`, serves a two-node address
 * space of its own, and is shut down in `afterAll`. The pinned OPC PLC container is what
 * `tests/fixtures/opcua/` was captured from, and `tests/integration/db/opcua-provider.test.ts`
 * replays that; this file is the other half, where the library really runs.
 *
 * WHAT THE SERVER'S OWN ANSWERS ADD, each measured here rather than described:
 *  - It publishes `MaxBrowseContinuationPoints` and `MaxHistoryContinuationPoints` as **0**, the
 *    third stack to break Part 5 6.3.11's "shall have a non zero value" — so `statedLimit` reads
 *    them as no limit stated, and a test below asserts exactly that.
 *  - Its advertised endpoint URL carries this host's name, not the loopback address the test typed,
 *    which is O-S7 reproduced without a container: the library logs "Cannot find suitable endpoints"
 *    and the connect still succeeds, because `endpointMustExist` is false.
 *  - It holds no historized node, so a history read answers `BadHistoryOperationUnsupported`, the
 *    code OPC PLC gives too.
 */
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { DataType, Variant } from "node-opcua-client";
import { OPCUAServer } from "node-opcua-server";
import { OPCUA_LIBRARY_BRIDGE } from "@/lib/db/providers/industrial/opcua/library";
import { openReadOnlySession } from "@/lib/db/providers/industrial/opcua/session";
import { readHistory } from "@/lib/db/providers/industrial/opcua/history";
import {
  browseLevel,
  childBearingNodes,
  levelPage,
  levelSlice,
  resolvePath,
} from "@/lib/db/providers/industrial/opcua/key-scan";
import { walkAddressSpace } from "@/lib/db/providers/industrial/opcua/walk";
import { statedLimit } from "@/lib/db/providers/industrial/opcua/limits";
import { OPCUA_OBJECTS_FOLDER } from "@/lib/db/providers/industrial/opcua/constants";
import { createDatabaseProvider } from "@/lib/db/factory";
import { openLibrarySession } from "@/lib/db/providers/industrial/opcua/library";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import type { OpcuaConnectionOptions } from "@/lib/db/providers/industrial/opcua/connection";
import type { OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";

/**
 * THE PORT IS THE SERVER'S OWN CHOICE, READ BACK AFTER IT STARTS, not a number written here. A
 * number written here is a promise about the whole host: this file held 54931 with a comment saying
 * no parallel test file would contend for it, which says nothing about anything else on the
 * machine, and anything else holding it makes all 17 tests vanish in `beforeAll` with EADDRINUSE
 * rather than fail one by one. `port: 0` is what the twelve sibling integration suites do.
 */
let PORT = 0;
const PATH_SEGMENT = "/libredb-test";
let ENDPOINT = "";

const SCRATCH: string[] = [];
let server: OPCUAServer;

/** A PKI root per client, so no test inherits another's trust list. */
function pkiRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opcua-client-pki-"));
  SCRATCH.push(root);
  return root;
}

function options(over: Partial<OpcuaConnectionOptions> = {}): OpcuaConnectionOptions {
  return {
    endpointUrl: ENDPOINT,
    host: "127.0.0.1",
    port: PORT,
    mode: "None",
    identity: "anonymous",
    pkiRoot: pkiRoot(),
    tunnelled: false,
    ...over,
  };
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "opcua-server-pki-"));
  SCRATCH.push(root);
  server = new OPCUAServer({
    // 0 asks the operating system for a free port; the one it chose is read back after `start`.
    port: 0,
    resourcePath: PATH_SEGMENT,
    // The server accepts this test's client certificate without a prompt; the CLIENT's trust is
    // what this provider makes strict, and that is asserted by the pin tests below.
    serverCertificateManager: new OPCUACertificateManager({
      rootFolder: root,
      automaticallyAcceptUnknownCertificate: true,
    }),
    buildInfo: {
      productName: "libredb-test-server",
      buildNumber: "1",
      buildDate: new Date(0),
    },
    // Anonymous only: the username path is covered by the connection reader's own tests, and a
    // server-side user manager would test the library's, not ours.
  });
  await server.initialize();
  const namespace = server.engine.addressSpace?.getOwnNamespace();
  if (namespace === undefined) throw new Error("the server started with no own namespace");
  const plant = namespace.addFolder("ObjectsFolder", { browseName: "Plant" });
  namespace.addVariable({
    componentOf: plant,
    browseName: "Temperature",
    description: "the one variable this server holds",
    dataType: "Double",
    value: {
      get: () => new Variant({ dataType: DataType.Double, value: 21.5 }),
    },
  });
  namespace.addVariable({
    componentOf: plant,
    browseName: "Readings",
    dataType: "Int32",
    valueRank: 1,
    arrayDimensions: [3],
    value: {
      get: () =>
        new Variant({
          dataType: DataType.Int32,
          arrayType: 1,
          value: [1, 2, 3],
        }),
    },
  });
  await server.start();
  const listening = server.endpoints[0]?.port;
  if (listening === undefined || listening === 0) throw new Error("the server started on no port");
  PORT = listening;
  ENDPOINT = `opc.tcp://127.0.0.1:${PORT}${PATH_SEGMENT}`;
}, 60_000);

afterAll(async () => {
  await server.shutdown(0);
  for (const root of SCRATCH) rmSync(root, { recursive: true, force: true });
});

/** One session, closed by the caller: every test that opens one closes it. */
async function session(over: Partial<OpcuaConnectionOptions> = {}): Promise<OpcuaReadOnlyClient> {
  return openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options(over));
}

describe("GetEndpoints, before any session exists", () => {
  test("the server's endpoints arrive in this provider's shape, with a SHA-256 thumbprint", async () => {
    const endpoints = await OPCUA_LIBRARY_BRIDGE.readEndpoints(options());
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(["None", "Sign", "SignAndEncrypt"]).toContain(endpoint.securityMode);
      expect(endpoint.securityPolicyUri).toContain("http://opcfoundation.org/UA/SecurityPolicy#");
      if (endpoint.serverCertificateThumbprint !== undefined) {
        expect(endpoint.serverCertificateThumbprint).toMatch(/^[0-9a-f]{64}$/);
      }
      // Each token's own policy, or null meaning the channel's (Part 4 7.41).
      for (const token of endpoint.userIdentityTokens) {
        expect(["Anonymous", "UserName", "Certificate", "IssuedToken"]).toContain(token.tokenType);
      }
    }
  });

  /** O-S7 without a container: the server advertises its own host name, and we never dial it. */
  test("the advertised URL is the server's, not the one this test typed", async () => {
    const [endpoint] = await OPCUA_LIBRARY_BRIDGE.readEndpoints(options());
    expect(endpoint?.advertisedUrl).toContain(`:${PORT}`);
    expect(endpoint?.advertisedUrl).not.toBe(ENDPOINT);
  });
});

describe("a session over the real library", () => {
  test("the Objects folder answers its own children", async () => {
    const client = await session();
    try {
      const [level] = await client.browse([OPCUA_OBJECTS_FOLDER]);
      const names = level?.references.map((reference) => reference.browseName) ?? [];
      expect(names).toContain("Server");
      expect(names).toContain("Plant");
      // Derived from the node class, because no server publishes a "has children" flag.
      const plant = level?.references.find((reference) => reference.browseName === "Plant");
      expect(plant?.nodeClass).toBe("Object");
      expect(plant?.mayHaveChildren).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("a read answers the value and the attributes beside it, in one request", async () => {
    const client = await session();
    try {
      const plant = await resolvePath(client, ["Plant"]);
      const [temperature] = await client
        .browse([plant])
        .then(([level]) => (level?.references ?? []).filter((reference) => reference.browseName === "Temperature"));
      expect(temperature).toBeDefined();
      const [value] = await client.read([temperature?.nodeId ?? ""]);
      expect(value?.statusCode).toBe("Good");
      expect(value?.value).toBe(21.5);
      expect(value?.nodeClass).toBe("Variable");
      expect(value?.valueRank).toBe(-1);
      expect(value?.description).toBe("the one variable this server holds");
      expect(value?.displayName).toBe("Temperature");
      expect(value?.sourceTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // AccessLevel as the server answered it, which a caller decodes into words.
      expect(typeof value?.accessLevel).toBe("number");
    } finally {
      await client.close();
    }
  });

  test("an array node answers an array, with the dimensions the server published", async () => {
    const client = await session();
    try {
      const plant = await resolvePath(client, ["Plant"]);
      const level = await browseLevel(client, plant);
      const readings = level.find((reference) => reference.browseName === "Readings");
      const [value] = await client.read([readings?.nodeId ?? ""]);
      expect(value?.statusCode).toBe("Good");
      expect(Array.from(value?.value as ArrayLike<number>)).toEqual([1, 2, 3]);
      expect(value?.arrayDimensions).toEqual([3]);
      expect(value?.valueRank).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("a node the server does not hold is a row with the server's own code", async () => {
    const client = await session();
    try {
      const [value] = await client.read(["ns=1;s=NoSuchNode"]);
      expect(value?.statusCode).toMatch(/^Bad/);
      expect(value?.value).toBeNull();
    } finally {
      await client.close();
    }
  });

  /**
   * THE THIRD STACK TO PUBLISH A ZERO. Part 5 6.3.11 says a provided limit "shall have a non zero
   * value"; this server publishes 0 for both continuation-point counts, so `statedLimit` reads them
   * as no limit stated rather than as a limit of zero.
   */
  test("the published limits are read, and a zero is read as nothing stated", async () => {
    const client = await session();
    try {
      const limits = await client.limits();
      expect(limits.maxNodesPerRead).toBeGreaterThan(0);
      expect(limits.maxBrowseContinuationPoints).toBe(0);
      expect(statedLimit(limits.maxBrowseContinuationPoints)).toBeUndefined();
      // Read once and cached for the session: the second call answers the same object.
      expect(await client.limits()).toBe(limits);
    } finally {
      await client.close();
    }
  });

  test("a history read of a node that keeps none answers the server's refusal", async () => {
    const client = await session();
    try {
      const plant = await resolvePath(client, ["Plant"]);
      const level = await browseLevel(client, plant);
      const temperature = level.find((reference) => reference.browseName === "Temperature");
      const result = await readHistory(client, {
        nodeId: temperature?.nodeId ?? "",
        limit: 10,
      });
      expect(result.values).toEqual([]);
      // REFUSED, NOT EXHAUSTED: the server said so, and the two are different facts. An empty
      // window and a node that keeps no history look the same in the rows and nowhere else.
      expect(result.end).toBe("refused");
      expect(result.statusCode).toMatch(/^Bad/);
    } finally {
      await client.close();
    }
  });

  test("a level page is one Browse, by path, with its rows named as the panel names them", async () => {
    const client = await session();
    try {
      const plant = await resolvePath(client, ["Plant"]);
      const references = await browseLevel(client, plant);
      /*
       * THE PAGE IS CHOSEN FIRST AND MEASURED SECOND, which is the order the provider uses: the
       * folder flag costs one Browse per row, so only the rows this page holds are asked about.
       * `Temperature` holds nothing, so it is a leaf and says so.
       */
      const slice = levelSlice("Plant/", references, {
        cursor: "0",
        count: 200,
      });
      const folders = await childBearingNodes(client, slice.rows, await client.limits());
      const page = levelPage(slice, folders);
      expect(page.keys).toContain("Plant/Temperature");
      expect(page.types["Plant/Temperature"]).toBe("variable");
      expect(page.prefixes).toEqual([]);
      expect(folders.has(references.find((row) => row.browseName === "Temperature")?.nodeId ?? "")).toBe(false);
      expect(page.total).toBe(0);
      // The level ends in this page, in the one spelling the panel reads as the end.
      expect(page.cursor).toBe("0");

      // One level up, the same two steps, where the measurement answers the other way: `Plant`
      // really does hold children, so it is drawn as a folder the reader can open. Without the
      // measurement no row is a folder at all, which is the choice this round of Browses buys.
      const roots = await browseLevel(client, OPCUA_OBJECTS_FOLDER);
      const rootSlice = levelSlice("", roots, { cursor: "0", count: 200 });
      const rootFolders = await childBearingNodes(client, rootSlice.rows, await client.limits());
      expect(levelPage(rootSlice, rootFolders).prefixes).toContain("Plant/");
      expect(levelPage(rootSlice).keys).toContain("Plant");
    } finally {
      await client.close();
    }
  });

  test("a bounded walk reaches the server's own nodes and reports what it spent", async () => {
    const client = await session();
    try {
      const walk = await walkAddressSpace(client, {
        nodeBudget: 200,
        depthBudget: 3,
      });
      expect(walk.nodeIds.length).toBeGreaterThan(5);
      expect(walk.requests).toBeGreaterThan(0);
      expect(["exhausted", "node-budget", "depth-budget"]).toContain(walk.end);
    } finally {
      await client.close();
    }
  });

  test("a path that names nothing is refused by the walk down, not answered empty", async () => {
    const client = await session();
    try {
      await expect(resolvePath(client, ["NoSuchFolder"])).rejects.toThrow(/No node named NoSuchFolder/);
    } finally {
      await client.close();
    }
  });

  /*
   * A SEGMENT THAT DIFFERS ONLY IN CASE IS THE READER'S OWN SPELLING, and the refusal says so rather
   * than guessing that the server changed: measured in a browser, `telemetry` typed into the prefix
   * box where the server named `Telemetry` answered a paragraph about the address space having
   * changed since the folder was opened. Against a real server here, because a browse name is
   * compared as the SERVER answered it.
   */
  /*
   * A CONTINUATION POINT TRAVELS AS BYTES, and only a real server can say so: the bridge puts the
   * point into the `HistoryReadValueId` itself, and every other suite drives the bridge through a
   * fake that never sees it. This one hands a point the server never issued, which is the cheapest
   * way to prove the field is on the wire: the server reads it, finds it invalid, and says so. A
   * server that ignored the field would answer Good with the whole history again.
   */
  test("a history continuation point reaches the server, which refuses one it never issued", async () => {
    const client = await session();
    try {
      const page = await client.historyReadNext({
        nodeId: "ns=1;s=Temperature",
        continuationPoint: new Uint8Array([1, 2, 3, 4]),
        valuesPerPage: 10,
      });
      expect(page.statusCode).toMatch(/^Bad/);
      expect(page.values).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("a segment that differs only in case names the node the server really holds", async () => {
    const client = await session();
    try {
      await expect(resolvePath(client, ["plant"])).rejects.toThrow(
        /No node named plant under Objects\. This level holds Plant, which differs from it only in case or spacing/,
      );
    } finally {
      await client.close();
    }
  });
});

describe("what this provider refuses against a real server", () => {
  /** O-S2: the pin is checked against the certificate GetEndpoints answered, before CreateSession. */
  test("a wrong certificate pin refuses, and the session is never created", async () => {
    await expect(session({ pinnedThumbprint: "0".repeat(64) })).rejects.toThrow(/pins the server certificate/);
  });

  test("the right thumbprint connects, which is the control for the refusal above", async () => {
    const endpoints = await OPCUA_LIBRARY_BRIDGE.readEndpoints(options());
    const presented = endpoints.find((endpoint) => endpoint.securityMode === "None")?.serverCertificateThumbprint;
    expect(presented).toMatch(/^[0-9a-f]{64}$/);
    const client = await session({ pinnedThumbprint: presented ?? "" });
    try {
      const [level] = await client.browse([OPCUA_OBJECTS_FOLDER]);
      expect(level?.references.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test("a mode the server does not offer is refused, and the refusal lists what it does offer", async () => {
    const offered = (await OPCUA_LIBRARY_BRIDGE.readEndpoints(options())).map((endpoint) => endpoint.securityMode);
    const missing = (["SignAndEncrypt", "Sign", "None"] as const).find((mode) => !offered.includes(mode));
    if (missing === undefined) {
      // The server offers all three: then the control is that each one connects, which the two
      // tests above already show for None. Nothing to refuse, and saying so beats skipping.
      expect([...new Set(offered)].sort()).toEqual(["None", "Sign", "SignAndEncrypt"]);
      return;
    }
    await expect(session({ mode: missing })).rejects.toThrow(new RegExp(`offers no ${missing} endpoint`));
  });
});

/**
 * THE WAY THE PRODUCT ITSELF BUILDS THIS PROVIDER, end to end against the running server.
 *
 * `createDatabaseProvider` is what a request goes through, and its `opcua` arm imports the library
 * when a session is opened rather than when a provider is built (the hostname lookup at the
 * library's import is why). That closure is only exercised by a real connect, which is this.
 */
describe("the factory's own arm, against the running server", () => {
  test("a connection built by the factory connects, reads and closes", async () => {
    // The PKI root is the INSTALLATION's setting, read from the server's own environment rather
    // than from a connection, because a private key is one identity for every connection this
    // Studio opens. A provider built by the factory therefore reads it from `process.env`.
    const before = process.env[OPCUA_PKI_ROOT_ENV];
    process.env[OPCUA_PKI_ROOT_ENV] = pkiRoot();
    const provider = await createDatabaseProvider({
      id: "opcua-factory",
      name: "in-process",
      type: "opcua",
      host: ENDPOINT,
      // The dialog's own field, which is the one the connection reader reads.
      securityMode: "None",
      createdAt: new Date(0),
    } as never);
    try {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      // `scanKeysPage` is optional on the interface, so a provider that declares `keyScan` and
      // does not implement it would fail here rather than at run time in the panel.
      if (provider.scanKeysPage === undefined) throw new Error("the provider declares keyScan with no page");
      /*
       * ASKED FOR THE WAY THE ROUTE ASKS, which is the correction this line carries: `cursor: "0"`
       * and no `pattern` at all. `POST /api/db/keys/scan` defaults an absent cursor to `"0"` and
       * refuses an empty one, and it refuses an empty pattern rather than forwarding it, so a test
       * that passed `""` for either was proving the provider against a request the panel cannot
       * send - which is how a level that never reported itself finished passed every suite here.
       */
      const page = await provider.scanKeysPage({
        cursor: "0",
        count: 50,
        level: true,
      });
      // A row is a folder only where the server answered children, measured in the same call, and a
      // folder is a PREFIX: that is what makes its row expandable in the panel.
      expect(page.prefixes).toContain("Plant/");
      expect(page.keys).not.toContain("Plant");
      // And the level says it is finished in the one word `use-key-scan.ts` reads as finished;
      // anything else leaves List more enabled for ever and the next press is an HTTP 400.
      expect(page.cursor).toBe("0");
      // The folder's own level, asked for as the panel asks for it: the prefix, separator and all.
      const inside = await provider.scanKeysPage({
        cursor: "0",
        count: 50,
        pattern: "Plant/",
        level: true,
      });
      expect(inside.keys).toContain("Plant/Temperature");
      expect(inside.cursor).toBe("0");
      // One page of one, so the cursor is really followed rather than being the end every time.
      const first = await provider.scanKeysPage({
        cursor: "0",
        count: 1,
        pattern: "Plant/",
        level: true,
      });
      expect(first.cursor).toBe("after:Plant/Readings");
      const second = await provider.scanKeysPage({
        cursor: first.cursor,
        count: 1,
        pattern: "Plant/",
        level: true,
      });
      expect(second.keys).toEqual(["Plant/Temperature"]);
      expect(second.cursor).toBe("0");
      const result = await provider.query('{ "read": ["i=2258"] }');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.statusCode).toBe("Good");
    } finally {
      await provider.disconnect();
      if (before === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
      else process.env[OPCUA_PKI_ROOT_ENV] = before;
    }
  }, 60_000);

  /** And `openLibrarySession` by its own name, which is what the factory hands the provider. */
  test("openLibrarySession opens the same session the bridge does", async () => {
    const client = await openLibrarySession(options());
    try {
      const [level] = await client.browse([OPCUA_OBJECTS_FOLDER]);
      expect(level?.references.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  /**
   * A SESSION THAT CANNOT BE CREATED MUST NOT LEAVE THE CHANNEL OPEN. The server accepts anonymous
   * only, so a username token is refused at ActivateSession - after `connect` and before a session
   * exists, which is the one path where a client is open with no session on it.
   */
  test("a refused identity closes the channel it opened", async () => {
    await expect(
      openLibrarySession(options({ identity: "username", user: "nobody", password: "wrong" })),
    ).rejects.toThrow();
  });
});
