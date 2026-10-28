/**
 * MTConnect provider, end to end over answers an MTConnect agent gave.
 *
 * The real MTConnectProvider runs: the connection, the window read, the guard, the streaming XML
 * reader, the row shapes and the refusals. Only the agent is replaced, by a loopback server that
 * serves the captures in `tests/fixtures/mtconnect/`, so the provider's own HTTP transport runs
 * too and nothing is called through a back door. A request no capture matches fails the case by
 * name rather than being answered with something invented.
 *
 * The captures were taken by `tests/live/mtconnect-evidence.ts` from the compose fixture
 * (`mtconnect/agent:2.8.0.4@sha256:c42f9085...` fed by `docker/mtconnect-init/adapter.py`), whose
 * buffer's own edges are read from `current.xml` at run time rather than typed here, and the two
 * sequence numbers the cases use are derived from them the way the evidence script derives them.
 *
 * WHY THE WINDOW HAS ITS OWN BLOCK BELOW: this provider shipped reading the sequence window from
 * the health read, `/sample?count=1`, whose Header reports the window of its own ANSWER. It
 * refused every `at` and every `from` above 2, telling the reader the agent's next sequence number
 * was 2, while the same agent answered those requests with 200. The captures hold the difference:
 * four of them carry the same firstSequence and lastSequence and four different nextSequence
 * values, so the cases can assert which Header a window may be read from.
 *
 * WHAT THIS FILE CANNOT SEE, and the reason `tests/live/mtconnect-live-check.ts` exists. Every
 * answer here is of one frozen moment: the captures were taken once, so the buffer in them never
 * advances. A second defect of the same family lived exactly there. The window is read at connect
 * and held, and a session that stayed open while the buffer moved refused sequences the agent was
 * willing to serve, with the number it reported at connect. No case below could fail on that,
 * because nothing below can make a buffer move. The live check found it on its first run and holds
 * it now.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ciStep as ciStepText } from "../../helpers/ci-step";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { join } from "node:path";
import type { DatabaseConnection } from "@/lib/types";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "mtconnect");

const capture = (name: string): string => readFileSync(join(FIXTURES, `${name}.xml`), "utf-8");

/** One Header field of one capture, read rather than typed. */
const sequenceOf = (name: string, key: string): number => {
  const found = new RegExp(`${key}="(\\d+)"`).exec(capture(name));
  if (found === null) throw new Error(`${name}.xml carries no ${key}, and this file reads it`);
  return Number(found[1]);
};

/**
 * The window comes from the capture, not from this file, so re-running the evidence script against
 * a fixture that has been up longer does not turn these cases red for the wrong reason. The two
 * sequence numbers are derived the way `tests/live/mtconnect-evidence.ts` derives them, which is
 * what makes them match the requests it captured.
 */
const BUFFER = {
  first: sequenceOf("current", "firstSequence"),
  last: sequenceOf("current", "lastSequence"),
  next: sequenceOf("current", "nextSequence"),
} as const;
const AT = BUFFER.last - 5;
const FROM = BUFFER.last - 8;

/** One capture per request, keyed by the request line the agent saw. */
const ANSWERS: ReadonlyMap<string, string> = new Map([
  ["/probe", capture("probe")],
  ["/current", capture("current")],
  [`/current?at=${AT}`, capture("current-at")],
  [`/sample?from=${FROM}&count=5`, capture("sample-from")],
  ["/sample?count=1", capture("sample-count-1")],
  ["/sample?count=-5", capture("sample-count-minus")],
  ["/assets", capture("assets")],
  ["/asset/TOOL-1722", capture("asset-tool")],
  [`/current?path=${encodeURIComponent('//DataItem[@category="CONDITION"]')}`, capture("current-condition")],
]);

/**
 * Error documents an agent answered with, served with the agent's own 400. Both are verbatim answers
 * of the demo agent (`tests/fixtures/mtconnect/2.8.0.3/README.md`). The `path` one is the request it
 * was captured for. The `from` one stands for a buffer that moved on between the window read and the
 * sample: the guard passes a `from` inside the window it holds, and the agent refuses it.
 */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  [
    `/current?path=${encodeURIComponent("//DataItem[")}`,
    readFileSync(join(FIXTURES, "2.8.0.3", "error-invalid-xpath.xml"), "utf-8"),
  ],
  [`/sample?from=${BUFFER.first}&count=5`, readFileSync(join(FIXTURES, "2.8.0.3", "error-out-of-range.xml"), "utf-8")],
]);

/**
 * A reverse proxy's own page where an observation read was asked for, served as nginx serves one.
 * It is not an MTConnect document at all, and the streaming reads have to say so rather than walk it.
 */
const PROXY_PAGE =
  "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>";
const PROXY_PAGES: ReadonlySet<string> = new Set(["/sample?count=2", `/current?at=${AT - 1}`]);

/** The Path prefix a reverse proxy puts in front of the agent; the fixture server answers under it too. */
const PROXY_PREFIX = "/mtc";

/** A Path prefix under which `/probe` answers a Streams document, which is MTConnect but no device model. */
const NOT_A_MODEL_PREFIX = "/not-a-model";

/** Every request the server was asked for, so a case can assert what never reached the agent. */
const seen: string[] = [];

let server: Server;
let port = 0;

const connection = (): DatabaseConnection =>
  ({ id: "mtc-fixture", name: "mtconnect fixture", type: "mtconnect", host: "127.0.0.1", port }) as DatabaseConnection;

const connected = async (): Promise<MTConnectProvider> => {
  const provider = new MTConnectProvider(connection(), {});
  await provider.connect();
  return provider;
};

function answer(request: IncomingMessage, response: ServerResponse): void {
  const line = request.url ?? "";
  seen.push(line);
  if (line === `${NOT_A_MODEL_PREFIX}/probe`) {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(capture("current"));
    return;
  }
  const prefix = [PROXY_PREFIX, NOT_A_MODEL_PREFIX].find((each) => line.startsWith(`${each}/`));
  const route = prefix === undefined ? line : line.slice(prefix.length);
  const refusal = REFUSALS.get(route);
  if (refusal !== undefined) {
    response.writeHead(400, { "content-type": "application/xml" });
    response.end(refusal);
    return;
  }
  if (PROXY_PAGES.has(route)) {
    response.writeHead(502, { "content-type": "text/html" });
    response.end(PROXY_PAGE);
    return;
  }
  const body = ANSWERS.get(route);
  if (body === undefined) {
    // Not 404: a 404 is an answer this provider knows how to read, and a missing capture is a
    // defect in the test rather than in the provider, so it has to look different.
    response.writeHead(599, { "content-type": "text/plain" });
    response.end(`no capture for ${line}`);
    return;
  }
  response.writeHead(200, { "content-type": "application/xml" });
  response.end(body);
}

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture server did not take a port");
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the captures carry the fact the window rule rests on", () => {
  test("four answers of one buffer agree on first and last and differ on next", () => {
    const header = (name: string): { first: number; last: number; next: number } => {
      const xml = capture(name);
      const read = (key: string): number => {
        const found = new RegExp(`${key}="(\\d+)"`).exec(xml);
        if (found === null) throw new Error(`${name} carries no ${key}`);
        return Number(found[1]);
      };
      return { first: read("firstSequence"), last: read("lastSequence"), next: read("nextSequence") };
    };
    const current = header("current");
    const windowed = ["sample-count-1", "sample-count-minus", "sample-from"].map(header);
    expect(current.next).toBe(current.last + 1);
    // The buffer's own edges are in every answer.
    for (const one of windowed) {
      expect({ first: one.first, last: one.last }).toEqual({ first: BUFFER.first, last: BUFFER.last });
    }
    // `nextSequence` is the one field a narrowing request rewrites, and it rewrites it by a
    // different rule for each key: a positive count reports the sequence after the FIRST row it
    // returned, a negative count reports one below the oldest it returned, and a `from` reports the
    // sequence after the last row of the page it served.
    expect(windowed.map((one) => one.next)).toEqual([2, BUFFER.last - 5, FROM + 5]);
    expect(windowed.every((one) => one.next !== current.next)).toBe(true);
  });

  test("the captures, the README and the compose pin name one agent", () => {
    // Three links, so a capture taken from another agent cannot arrive unnoticed: the image
    // `database-compose.yml` pins, the version the captures' own Header reports, and the README
    // that records where they came from. A capture from a different build breaks the middle link;
    // a compose bump without a re-capture breaks the outer two.
    const compose = readFileSync(join(import.meta.dir, "..", "..", "..", "database-compose.yml"), "utf-8");
    const pin = /image:\s*(mtconnect\/agent:([\d.]+)@sha256:([a-f0-9]{64}))/.exec(compose);
    expect(pin, "database-compose.yml pins no mtconnect/agent image").not.toBeNull();
    const [, image, version] = pin as RegExpExecArray;
    const readme = readFileSync(join(FIXTURES, "README.md"), "utf-8");
    expect(readme).toContain(image);
    // The CI step is the fourth place the same pin appears, and the one furthest from a reader's
    // eye: a bump here that misses it would run CI against a different agent than the captures.
    const ciStep = ciStepText("MTConnect provider check");
    expect(ciStep).toContain(image);
    expect(readme).toContain(`version`);
    for (const name of ["probe", "current", "assets"]) {
      const header = /<Header[^>]*\sversion="([\d.]+)"/.exec(capture(name));
      expect(header, `${name}.xml carries no Header version`).not.toBeNull();
      expect((header as RegExpExecArray)[1], name).toBe(version);
    }
  });

  test("probe carries no sequence at all, so it cannot be a window source", () => {
    const probe = capture("probe");
    expect(probe).toContain("MTConnectDevices");
    expect(/firstSequence=|lastSequence=|nextSequence=/.test(probe)).toBe(false);
  });
});

describe("a read inside the buffer's window is served", () => {
  test("the window is read from an answer no key narrowed", async () => {
    seen.length = 0;
    const provider = await connected();
    // The window read is the first request a connection makes, and it is `/current`. If it were the
    // health read, every case below would refuse with "next sequence number of 2".
    expect(seen[0]).toBe("/current");
    await provider.disconnect();
  });

  test("`at` inside the window answers rows rather than a refusal", async () => {
    const provider = await connected();
    const result = await provider.query(`GET /current?at=${AT}`);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.rows.some((row) => String((row as Record<string, unknown>).value) === "LIBREDB-TEST.NC")).toBe(true);
    await provider.disconnect();
  });

  test("`from` inside the window answers rows rather than a refusal", async () => {
    const provider = await connected();
    const result = await provider.query(`GET /sample?from=${FROM}&count=5`);
    expect(result.rowCount).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("a sequence past the buffer is refused, and the refusal carries the agent's own next", async () => {
    const provider = await connected();
    seen.length = 0;
    await expect(provider.query("GET /sample?from=999999999&count=5")).rejects.toThrow(
      `from is 999999999, past the agent's next sequence number of ${BUFFER.next}.`,
    );
    // The refusal is made before the read leaves: the agent is never asked for the sample. Two
    // requests do reach it, and both are named here rather than allowed by a loose matcher: the
    // model a fresh connection reads, and the ONE window read the provider makes before it refuses
    // a `window` case, since a window held since connect may be older than the buffer. The cost of
    // that second read is one per refusal and never a loop, which is what this list pins.
    expect(seen.filter((line) => line.startsWith("/sample"))).toEqual([]);
    expect(seen).toEqual(["/probe", "/current"]);
    await provider.disconnect();
  });
});

describe("the reads the issue promises", () => {
  test("probe answers the device model the fixture declares", async () => {
    const provider = await connected();
    const result = await provider.query("GET /probe");
    expect(result.rowCount).toBeGreaterThan(0);
    // The name column is the data item's path through the components, not its bare name: the
    // fixture's X axis arrives as the Linear component inside the Axes component.
    const names = result.rows.map((row) => String((row as Record<string, unknown>).name));
    expect(names).toContain("Axes:base/Linear:X/Xposition");
    expect(names).toContain("Controller:controller/Path:path1/execution");
    // Both devices of the answer are read, the agent's own and the machine's.
    const devices = [...new Set(result.rows.map((row) => String((row as Record<string, unknown>).device)))];
    expect(devices.sort()).toEqual(["Agent", "LIBREDB-LATHE-1722"]);
    await provider.disconnect();
  });

  test("current answers the values the device sent", async () => {
    const provider = await connected();
    const result = await provider.query("GET /current");
    const values = result.rows.map((row) => String((row as Record<string, unknown>).value));
    expect(values).toContain("3600");
    expect(values).toContain("ACTIVE");
    expect(values).toContain("LIBREDB-TEST.NC");
    await provider.disconnect();
  });

  test("assets answer one row, and one asset answers its own document", async () => {
    const provider = await connected();
    const list = await provider.query("GET /assets");
    expect(list.rowCount).toBe(1);
    expect(String((list.rows[0] as Record<string, unknown>).assetId)).toBe("TOOL-1722");
    // The asset's own attributes travel as columns of the row, each named by the attribute the
    // asset type declares, so a CuttingTool brings `toolId` and `serialNumber` with it.
    const one = await provider.query("GET /asset/TOOL-1722");
    expect(one.rowCount).toBe(1);
    const asset = one.rows[0] as Record<string, unknown>;
    expect({ toolId: String(asset.toolId), serialNumber: String(asset.serialNumber) }).toEqual({
      toolId: "T1722",
      serialNumber: "SN-1722",
    });
    await provider.disconnect();
  });

  test("a condition is read as a condition rather than as a sample", async () => {
    const provider = await connected();
    const result = await provider.query(`GET /current?path=${'//DataItem[@category="CONDITION"]'}`);
    expect(result.rowCount).toBe(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(String(row.category)).toBe("CONDITION");
    expect(String(row.nativeCode)).toBe("SYS-1722");
    await provider.disconnect();
  });
});

describe("an agent's error document reaches the reader on every route", () => {
  test("a path the agent refuses on current is the agent's sentence, not an empty grid", async () => {
    const provider = await connected();
    await expect(provider.query("GET /current?path=//DataItem[")).rejects.toThrow(
      "The path could not be parsed. Invalid syntax: //DataItem[ (INVALID_XPATH)",
    );
    await provider.disconnect();
  });

  test("a from the agent refuses on sample is the agent's sentence, not an empty grid", async () => {
    const provider = await connected();
    await expect(provider.query(`GET /sample?from=${BUFFER.first}&count=5`)).rejects.toThrow(
      "'from' must be greater than 29516470 (OUT_OF_RANGE)",
    );
    await provider.disconnect();
  });
});

describe("a proxy's page where observations were asked for is named, never walked", () => {
  test("on sample", async () => {
    const provider = await connected();
    await expect(provider.query("GET /sample?count=2")).rejects.toThrow(
      "its document's root element is html rather than an MTConnect one",
    );
    await provider.disconnect();
  });

  test("on current", async () => {
    const provider = await connected();
    await expect(provider.query(`GET /current?at=${AT - 1}`)).rejects.toThrow(
      "its document's root element is html rather than an MTConnect one",
    );
    await provider.disconnect();
  });
});

describe("the connection's Path prefix", () => {
  test("is put in front of every route the provider sends", async () => {
    seen.length = 0;
    const provider = new MTConnectProvider({ ...connection(), apiPath: `${PROXY_PREFIX}/` }, {});
    await provider.connect();
    const result = await provider.query("GET /current");
    expect(result.rowCount).toBeGreaterThan(0);
    expect(seen).toEqual([`${PROXY_PREFIX}/current`, `${PROXY_PREFIX}/probe`, `${PROXY_PREFIX}/current`]);
    await provider.disconnect();
  });
});

describe("a probe that answers no device model", () => {
  test("is refused by name, before any observation is read against it", async () => {
    const provider = new MTConnectProvider({ ...connection(), apiPath: `${NOT_A_MODEL_PREFIX}/` }, {});
    await provider.connect();
    await expect(provider.query("GET /current")).rejects.toThrow(
      "This address answered a document that is not an MTConnect device model.",
    );
    await provider.disconnect();
  });
});

describe("an agent served over https", () => {
  const material = loadTlsFixtures();
  let tlsServer: HttpsServer;
  let tlsPort = 0;

  beforeAll(async () => {
    tlsServer = createHttpsServer({ cert: material.server.cert, key: material.server.key }, answer);
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const address = tlsServer.address();
    if (address === null || typeof address === "string") throw new Error("the TLS fixture server did not take a port");
    tlsPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  });

  test("is read with the CA the SSL / TLS panel carries", async () => {
    const provider = new MTConnectProvider(
      { ...connection(), port: tlsPort, ssl: { mode: "verify-full", caCert: material.ca } },
      {},
    );
    await provider.connect();
    const result = await provider.query("GET /current");
    expect(result.rowCount).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("is refused as a TLS failure when another CA is given, and nothing is asked over http", async () => {
    seen.length = 0;
    const provider = new MTConnectProvider(
      { ...connection(), port: tlsPort, ssl: { mode: "verify-full", caCert: material.otherCa } },
      {},
    );
    await expect(provider.connect()).rejects.toThrow("The TLS connection failed");
    expect(seen).toEqual([]);
    await provider.disconnect();
  });
});
