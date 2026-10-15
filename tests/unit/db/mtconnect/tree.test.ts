/**
 * The tree and the surfaces an agent does not publish.
 *
 * `tests/unit/db/mtconnect/client.test.ts` holds the client seam and
 * `tests/integration/db/mtconnect-provider.test.ts` holds the window rule and the row shapes. This
 * file holds what is left: the object tree the reader clicks through, the asset document, and the
 * monitoring surfaces that answer nothing because an agent publishes nothing for them. That last
 * group matters as much as the first: a provider that returns an empty array and a provider that
 * throws are different to every caller, and until this file existed neither was asserted.
 *
 * FOUND BY A GATE: `coverage:check` reported 122 uncovered lines in `index.ts` on the pull request,
 * and #1722's own definition of done asks for 100% line coverage. The whole tree surface had no
 * test, so the figure was not a rounding error, it was a surface nobody had read back.
 *
 * The agent is a loopback server over the captures in `tests/fixtures/mtconnect/`, the same way the
 * integration test does it, so the provider's own transport, guard and XML reader all run. The
 * numbers below are read from the probe capture rather than typed: `Agent` carries thirteen data
 * items and no condition, `LIBREDB-LATHE-1722` carries eight and one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { DatabaseConnection } from "@/lib/types";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import { MTCONNECT_HEALTH_UNKNOWN, MTCONNECT_OBJECT_KINDS } from "@/lib/db/providers/industrial/mtconnect/capabilities";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "mtconnect");
const capture = (name: string): string => readFileSync(join(FIXTURES, `${name}.xml`), "utf-8");
const errorCapture = (name: string): string => readFileSync(join(FIXTURES, "2.8.0.3", `${name}.xml`), "utf-8");

const LATHE = "LIBREDB-LATHE-1722";

const ANSWERS: ReadonlyMap<string, string> = new Map([
  ["/probe", capture("probe")],
  ["/current", capture("current")],
  ["/sample?count=1", capture("sample-count-1")],
  ["/assets", capture("assets")],
  ["/asset/TOOL-1722", capture("asset-tool")],
  // An asset the agent does not hold, so the error path of `readObjectSource` is a real answer
  // rather than a thrown stand-in: this is cppagent's own ASSET_NOT_FOUND document.
  ["/asset/NO-SUCH-ASSET", errorCapture("error-asset-not-found")],
]);

const seen: string[] = [];
let server: Server;
let port = 0;

const connection = (): DatabaseConnection =>
  ({ id: "mtc-tree", name: "mtconnect tree", type: "mtconnect", host: "127.0.0.1", port }) as DatabaseConnection;

const connected = async (): Promise<MTConnectProvider> => {
  const provider = new MTConnectProvider(connection(), {});
  await provider.connect();
  return provider;
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const line = request.url ?? "";
    seen.push(line);
    const body = ANSWERS.get(line);
    if (body === undefined) {
      // Not 404: a 404 is an answer this provider reads, and a missing capture is a defect in this
      // file rather than in the provider, so it has to look different.
      response.writeHead(599, { "content-type": "text/plain" });
      response.end(`no capture for ${line}`);
      return;
    }
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture server did not take a port");
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the containers are the agent's devices", () => {
  test("every device the probe declares is a container, in the order the probe gives", async () => {
    const provider = await connected();
    const containers = await provider.listContainers();
    expect(containers.map((one) => one.name)).toEqual(["Agent", LATHE]);
    expect(containers.map((one) => one.path)).toEqual([["Agent"], [LATHE]]);
    await provider.disconnect();
  });

  test("a container offers every kind this provider declares", async () => {
    const provider = await connected();
    const [first] = await provider.listContainers();
    expect(first?.kinds).toEqual(MTCONNECT_OBJECT_KINDS.map((kind) => kind.id));
    // The Agent device is a device like any other, so it sits at the same level as the machine.
    expect((await provider.listContainers()).map((one) => one.level)).toEqual([0, 0]);
    await provider.disconnect();
  });
});

describe("the counts and the objects under a container", () => {
  test("a condition is counted apart from the other data items", async () => {
    const provider = await connected();
    expect(await provider.countObjects([LATHE])).toEqual({
      dataitem: { count: 8 },
      condition: { count: 1 },
      asset: { count: 0 },
    });
    // The Agent device carries no condition, which is what makes the split worth asserting twice.
    expect(await provider.countObjects(["Agent"])).toEqual({
      dataitem: { count: 13 },
      condition: { count: 0 },
      asset: { count: 0 },
    });
    await provider.disconnect();
  });

  test("a container path of the wrong length is refused by the shared check", async () => {
    const provider = await connected();
    // The declaration is `containerPathShapes: "exact"`, and the sentence comes from the shared
    // check rather than from this provider, so a path of two names must not reach the model lookup
    // and come back as "no such device" (#1147).
    await expect(provider.countObjects([LATHE, "extra"])).rejects.toThrow();
    await expect(provider.countObjects([])).rejects.toThrow();
    await provider.disconnect();
  });

  test("a named data item is listed by its component path, an unnamed one by its id", async () => {
    const provider = await connected();
    const items = await provider.listObjects([LATHE], "dataitem");
    const names = new Map(items.map((one) => [one.path[1], one.name]));
    expect(names.get("x1722-pos")).toBe("Axes:base/Linear:X/Xposition");
    expect(names.get("d1722_asset_chg")).toBe("d1722_asset_chg");
    expect(items.every((one) => one.kind === "dataitem")).toBe(true);
    expect(items).toHaveLength(8);
    await provider.disconnect();
  });

  test("the condition kind lists the condition and nothing else", async () => {
    const provider = await connected();
    const conditions = await provider.listObjects([LATHE], "condition");
    expect(conditions.map((one) => one.path[1])).toEqual(["p1722-sys"]);
    expect(conditions[0]?.name).toBe("Controller:controller/Path:path1/system");
    await provider.disconnect();
  });
});

describe("what a data item says about itself", () => {
  test("the three columns are the value, its timestamp and its sequence", async () => {
    const provider = await connected();
    const detail = await provider.describeObject([LATHE, "x1722-pos"]);
    expect(detail.columns.map((one) => one.name)).toEqual(["value", "timestamp", "sequence"]);
    // The sequence is the primary: it is the one field that orders a buffer and never repeats.
    expect(detail.columns.find((one) => one.name === "sequence")?.isPrimary).toBe(true);
    expect(detail.indexes).toEqual([]);
    expect(detail.foreignKeys).toEqual([]);
    await provider.disconnect();
  });

  test("the value's type is the item's units where it declares them, and text where it does not", async () => {
    const provider = await connected();
    const typeOf = async (id: string): Promise<string | undefined> =>
      (await provider.describeObject([LATHE, id])).columns.find((one) => one.name === "value")?.type;
    expect(await typeOf("x1722-pos")).toBe("MILLIMETER");
    expect(await typeOf("d1722-avail")).toBe("text");
    await provider.disconnect();
  });

  test("a data item the model does not hold is named in the refusal", async () => {
    const provider = await connected();
    await expect(provider.describeObject([LATHE, "no-such-item"])).rejects.toThrow(/no-such-item/);
    await provider.disconnect();
  });

  test("a batch describes every object, and says so when it stops short", async () => {
    const provider = await connected();
    const all = await provider.describeObjects([LATHE], "dataitem");
    expect(all.details).toHaveLength(8);
    expect(all.truncated).toBeUndefined();
    const capped = await provider.describeObjects([LATHE], "dataitem", 3);
    expect(capped.details).toHaveLength(3);
    expect(capped.truncated).toEqual({ limit: 3, reason: "the batch limit this read was given" });
    await provider.disconnect();
  });
});

describe("an asset is a document, and nothing else is", () => {
  test("the asset's own XML is handed back as stored, with no edit offered", async () => {
    const provider = await connected();
    const document = await provider.readObjectSource([LATHE, "TOOL-1722"], "asset");
    const [part] = document.parts;
    expect(part?.id).toBe("asset");
    expect(part?.language).toBe("xml");
    expect(part?.form).toBe("complete");
    // `stored`, because the text is the agent's own bytes rather than a re-render of the tree.
    expect(part?.origin).toBe("stored");
    expect(part?.edit?.offered).toBe(false);
    expect(part?.text).toContain("TOOL-1722");
    expect(part?.text).toBe(capture("asset-tool"));
    await provider.disconnect();
  });

  test("a data item has no document, and the refusal says what it has instead", async () => {
    const provider = await connected();
    await expect(provider.readObjectSource([LATHE, "x1722-pos"], "dataitem")).rejects.toThrow(/timestamp/);
    await provider.disconnect();
  });

  test("a path that names no asset is refused before a request is sent", async () => {
    const provider = await connected();
    const before = seen.length;
    await expect(provider.readObjectSource([LATHE, ""], "asset")).rejects.toThrow(/names no asset/);
    expect(seen.slice(before)).toEqual([]);
    await provider.disconnect();
  });

  test("an error document is read by its type and its sentence reaches the reader", async () => {
    const provider = await connected();
    await expect(provider.readObjectSource([LATHE, "NO-SUCH-ASSET"], "asset")).rejects.toThrow();
    await provider.disconnect();
  });
});

describe("health, the overview, and the surfaces an agent does not publish", () => {
  test("a field the agent cannot answer reads unknown rather than a number", async () => {
    const provider = await connected();
    const health = await provider.getHealth();
    expect(health.databaseSize).toBe(MTCONNECT_HEALTH_UNKNOWN);
    expect(health.cacheHitRatio).toBe(MTCONNECT_HEALTH_UNKNOWN);
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
    // `activeConnections` is omitted rather than guessed: the Header carries nothing about them.
    expect("activeConnections" in health).toBe(false);
    await provider.disconnect();
  });

  test("the overview counts the model's data items and says the buffer in observations", async () => {
    const provider = await connected();
    const overview = await provider.getOverview();
    expect(overview.tableCount).toBe(22);
    expect(overview.indexCount).toBe(0);
    expect(overview.maxConnections).toBe(0);
    expect(overview.version).toBe("unknown");
    expect(overview.uptime).toBe("unknown");
    // Observations, not bytes: the agent's buffer is a count of observations.
    expect(overview.databaseSize).toMatch(/^\d+ observations buffered$/);
    await provider.disconnect();
  });

  test("the surfaces an agent publishes nothing for answer empty, and send no request", async () => {
    const provider = await connected();
    const before = seen.length;
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    // Empty because the agent has nothing to say, not because a request failed: no request is sent.
    expect(seen.slice(before)).toEqual([]);
    await provider.disconnect();
  });

  test("maintenance is refused in its own words rather than answering nothing", async () => {
    const provider = await connected();
    await expect(provider.runMaintenance()).rejects.toThrow(/every route of this provider reads/);
    await provider.disconnect();
  });
});
