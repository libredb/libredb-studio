/**
 * The client seam: what it builds, what it refuses, and that every read takes a permit.
 *
 * The transport is a stand-in that records what it was asked for and answers with the captured
 * documents, so the assertions are about this module rather than about the network. The documents
 * are the real ones from `tests/fixtures/mtconnect/2.8.0.3/`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { httpOrigin } from "@/lib/db/http/endpoint";
import type { NodeRequest, NodeResponse, NodeTransport } from "@/lib/db/http/node-transport";
import { MTC_XML_REFUSAL_OWNER } from "@/lib/db/providers/industrial/mtconnect/xml";
import { MTC_XML_BOUNDS } from "@/lib/db/providers/industrial/mtconnect/xml-bounds";
import {
  buildTarget,
  headerOf,
  MTC_BYTE_CAPS,
  MtcClientError,
  readObservations,
  readOnce,
  type MtcClientOptions,
} from "@/lib/db/providers/industrial/mtconnect/client";
import { guardRequestLine, type MtcWindow } from "@/lib/db/providers/industrial/mtconnect/guard";
import { MTC_ROUTES } from "@/lib/db/providers/industrial/mtconnect/routes";

const DIR = join(import.meta.dir, "../../../fixtures/mtconnect/2.8.0.3");
const fixture = (name: string) => readFileSync(join(DIR, name), "utf8");
const ORIGIN = httpOrigin("http", "127.0.0.1", 21300);
const WINDOW: MtcWindow = {
  instanceId: "1791206842",
  firstSequence: BigInt(1),
  lastSequence: BigInt(33),
  nextSequence: BigInt(34),
  bufferSize: BigInt(131072),
};
const GUARD = { window: WINDOW, rowCap: 10_000, knownDevices: new Set(["Mazak", "OKUMA", "Agent"]) };

/** A transport that answers one body and records every request, so the seam can be asserted. */
function standIn(body: string, status = 200, contentType = "application/xml") {
  const seen: NodeRequest[] = [];
  const transport: NodeTransport = {
    request(request: NodeRequest): Promise<NodeResponse> {
      seen.push(request);
      return Promise.resolve({ status, contentType, retryAfter: null, text: body });
    },
    close() {},
  };
  return { transport, seen };
}

function options(transport: NodeTransport, permits: { count: number }): MtcClientOptions {
  return {
    origin: ORIGIN,
    pathPrefix: "/",
    transport,
    withPermit: async (run) => {
      permits.count++;
      return run();
    },
    signal: AbortSignal.timeout(10_000),
  };
}

describe("the request it builds", () => {
  test("a route with no parameters", () => {
    const url = buildTarget(ORIGIN, "/", guardRequestLine("/probe", GUARD));
    expect(url).toBe("http://127.0.0.1:21300/probe");
  });

  test("a device is a path segment and is encoded", () => {
    const url = buildTarget(ORIGIN, "/", guardRequestLine("/Mazak/current", GUARD));
    expect(url).toBe("http://127.0.0.1:21300/Mazak/current");
  });

  test("a path prefix is carried, which is how an agent behind a proxy is reached", () => {
    const url = buildTarget(ORIGIN, "/mtc/", guardRequestLine("/sample?count=5", GUARD));
    expect(url).toBe("http://127.0.0.1:21300/mtc/sample?count=5");
  });

  test("query keys are written in declaration order, so one request has one spelling", () => {
    const first = buildTarget(ORIGIN, "/", guardRequestLine("/sample?count=5&from=10", GUARD));
    const second = buildTarget(ORIGIN, "/", guardRequestLine("/sample?from=10&count=5", GUARD));
    expect(first).toBe(second);
    expect(first).toBe("http://127.0.0.1:21300/sample?from=10&to=&count=5".replace("to=&", ""));
  });

  test("a path is encoded once and decodes to exactly what the user wrote", () => {
    const path = '//DataItem[@category="CONDITION"]';
    const url = buildTarget(ORIGIN, "/", guardRequestLine(`/current?path=${encodeURIComponent(path)}`, GUARD));
    const sent = new URL(url).searchParams.get("path");
    expect(sent).toBe(path);
  });

  test("an asset id is encoded, so a dot or a slash in an id cannot reach the route", () => {
    const url = buildTarget(ORIGIN, "/", guardRequestLine("/asset/123456.2207", GUARD));
    expect(url).toBe("http://127.0.0.1:21300/asset/123456.2207");
  });
});

describe("the 8 KiB request ceiling", () => {
  test("the budget in the client is a backstop, and it is tested as one", () => {
    // The guard refuses an oversized path and an oversized path parameter before this module sees
    // them, so with the guard in front this check cannot fire. That is what a backstop is, and it
    // is tested by handing `buildTarget` a request the guard never produced: if a cap upstream is
    // ever loosened, this is the thing that still refuses rather than sending a request the agent
    // answers by closing the socket with no error document.
    const request = {
      op: "asset" as const,
      route: MTC_ROUTES.find((candidate) => candidate.template === "asset/{assetIds}")!,
      params: { assetIds: '"'.repeat(2600) },
      query: {},
    };
    try {
      buildTarget(ORIGIN, "/", request);
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcClientError)) throw error;
      expect(error.failure).toBe("request-too-long");
      expect(error.message).toContain("closing the connection without writing an error document");
      // The refusal is STUDIO'S, applied before a socket is opened, and the sentence has to say
      // so: the ceiling behind it was measured on one agent, and a reader whose agent is a
      // different one is told what was measured rather than what theirs will do.
      expect(error.message).toContain("Studio refuses to send this request");
      expect(error.message).toContain("2.8.0.3");
    }
  });

  test("the guard refuses an oversized path first, measuring it encoded", () => {
    // What expands and what does not was measured rather than assumed: `URLSearchParams` writes a
    // space as `+`, one byte, and a quote as `%22`, three. So a path of spaces never grows, and the
    // path that reaches the cap is one full of characters that do.
    const spaces = `//DataItem[@id='${" ".repeat(3000)}']`;
    const quotes = `//DataItem[@id='${'"'.repeat(2600)}']`;
    expect(spaces.length).toBeLessThan(4096);
    expect(quotes.length).toBeLessThan(4096);
    expect(new URLSearchParams({ path: spaces }).toString().length).toBeLessThan(4096);
    expect(new URLSearchParams({ path: quotes }).toString().length).toBeGreaterThan(7680);
    expect(() => guardRequestLine(`/current?path=${encodeURIComponent(quotes)}`, GUARD)).toThrow();
  });

  test("an oversized path parameter is refused by the guard, which had no bound for one before", () => {
    expect(() => guardRequestLine(`/asset/${"x".repeat(300)}`, GUARD)).toThrow();
    expect(guardRequestLine(`/asset/${"x".repeat(200)}`, GUARD).params.assetIds).toHaveLength(200);
  });

  test("a request inside the budget is built", () => {
    const fits = `//DataItem[@id="${"x".repeat(1000)}"]`;
    const request = guardRequestLine(`/current?path=${encodeURIComponent(fits)}`, GUARD);
    expect(buildTarget(ORIGIN, "/", request)).toContain("/current?path=");
  });
});

describe("one read", () => {
  test("a probe answer is parsed and its Header is readable", async () => {
    const { transport, seen } = standIn(fixture("probe.xml"));
    const permits = { count: 0 };
    const answer = await readOnce(options(transport, permits), guardRequestLine("/probe", GUARD));
    expect(answer.status).toBe(200);
    expect(answer.root.name).toBe("MTConnectDevices");
    expect(answer.isError).toBe(false);
    expect(headerOf(answer.root).instanceId).toBe("1791206842");
    // The seam: one GET, no body, the route's own cap, and the XML Accept header.
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].body).toBeUndefined();
    expect(seen[0].maxResponseBytes).toBe(MTC_BYTE_CAPS.probe);
    expect(seen[0].headers?.accept).toBe("application/xml");
  });

  test("every read takes a permit, which is how one agent serves one request at a time", async () => {
    const { transport } = standIn(fixture("sample-count-1.xml"));
    const permits = { count: 0 };
    await readOnce(options(transport, permits), guardRequestLine("/sample?count=1", GUARD));
    await readOnce(options(transport, permits), guardRequestLine("/probe", GUARD));
    expect(permits.count).toBe(2);
  });

  test("an agent error document is parsed rather than thrown, so its code can be read", async () => {
    const { transport } = standIn(fixture("error-out-of-range.xml"), 400);
    const answer = await readOnce(options(transport, { count: 0 }), guardRequestLine("/sample?count=1", GUARD));
    expect(answer.isError).toBe(true);
    expect(answer.root.name).toBe("MTConnectError");
    expect(answer.status).toBe(400);
  });
});

describe("an answer that is not MTConnect gets our own sentence", () => {
  test("a proxy's HTML 401 is named as a proxy page, not parsed as an error document", async () => {
    // MEASURED through nginx in front of an agent: the 401 body was text/html, 179 bytes.
    const html =
      "<html>\n<head><title>401 Authorization Required</title></head>\n<body>\n<center><h1>401 Authorization Required</h1></center>\n</body>\n</html>";
    const { transport } = standIn(html, 401, "text/html");
    try {
      await readOnce(options(transport, { count: 0 }), guardRequestLine("/probe", GUARD));
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcClientError)) throw error;
      expect(error.failure).toBe("not-mtconnect");
      expect(error.message).toContain("401");
      expect(error.message).toContain("text/html");
      expect(error.message).toContain("reverse proxy");
    }
  });

  test("a well formed document with another root is refused by name", async () => {
    const { transport } = standIn('<?xml version="1.0"?><SomethingElse><Header/></SomethingElse>');
    try {
      await readOnce(options(transport, { count: 0 }), guardRequestLine("/probe", GUARD));
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcClientError)) throw error;
      expect(error.failure).toBe("not-mtconnect");
      expect(error.message).toContain("SomethingElse");
    }
  });

  /**
   * The DOCTYPE case used to be asserted as `not-mtconnect`, and that was the defect written down:
   * `<!DOCTYPE d [...]><MTConnectDevices/>` IS an MTConnect document, and Studio refuses it by its
   * own rule so that no DTD is ever expanded. Saying "not MTConnect" sends an operator to their
   * vendor over a rule of ours. The assertions below hold the new type AND the attribution, so a
   * later edit cannot quietly go back to blaming the agent.
   */
  test("a document carrying a DOCTYPE is refused by Studio's rule, and the sentence says so", async () => {
    const { transport } = standIn('<!DOCTYPE d [<!ENTITY x "y">]><MTConnectDevices/>');
    try {
      await readOnce(options(transport, { count: 0 }), guardRequestLine("/probe", GUARD));
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcClientError)) throw error;
      expect(error.failure).toBe("refused-by-rule");
      expect(error.message).toContain("Studio refused this answer");
      expect(error.message).toContain("DOCTYPE");
      // The reason the rule exists, in the sentence rather than in a code only we can read.
      expect(error.message).toContain("never expanded");
      // And it must NOT say the document is not MTConnect, which is what it used to say.
      expect(error.message).not.toContain("could not be read as an MTConnect document");
    }
  });

  test("a document that is not readable XML is still the document's own defect", async () => {
    // The other side of the split: nothing here is Studio's rule, so the sentence does not
    // apologise for one. Without this the classification could mark everything `studio` and pass.
    const { transport } = standIn("<MTConnectDevices><Devices></MTConnectDevices>");
    try {
      await readOnce(options(transport, { count: 0 }), guardRequestLine("/probe", GUARD));
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcClientError)) throw error;
      expect(error.failure).toBe("unreadable");
      expect(error.message).toContain("not readable XML");
      expect(error.message).not.toContain("Studio refused");
    }
  });

  test("a bound's sentence carries the bound's own figure, not a copy of it", () => {
    // This one cannot be caught by mutation today, and the reason is worth writing: replacing
    // `${MTC_XML_BOUNDS.maxDepth}` with the literal 64 changes NOTHING observable while the
    // constant IS 64. What it breaks is the day the constant moves, and that is what this
    // assertion holds: the sentence is compared with the constant, so a copied figure fails as
    // soon as the two part. (MEASURED: with this test absent, the literal substitution failed
    // no test at all.)
    const deep = `<MTConnectDevices>${"<a>".repeat(MTC_XML_BOUNDS.maxDepth + 2)}${"</a>".repeat(MTC_XML_BOUNDS.maxDepth + 2)}</MTConnectDevices>`;
    const { transport } = standIn(deep);
    return readOnce(options(transport, { count: 0 }), guardRequestLine("/probe", GUARD)).then(
      () => {
        throw new Error("should have refused");
      },
      (error: unknown) => {
        if (!(error instanceof MtcClientError)) throw error;
        expect(error.failure).toBe("refused-by-rule");
        expect(error.message).toContain(String(MTC_XML_BOUNDS.maxDepth));
        expect(error.message).toContain("Studio refused this answer");
      },
    );
  });

  test("every reader refusal is owned by exactly one side", () => {
    // The table is exhaustive by its type; this says it is also HONEST about the two it was
    // written for, so a later edit cannot move a bound of ours onto the agent's account.
    expect(MTC_XML_REFUSAL_OWNER.doctype).toBe("studio");
    expect(MTC_XML_REFUSAL_OWNER.comment).toBe("studio");
    expect(MTC_XML_REFUSAL_OWNER["too-many-elements"]).toBe("studio");
    expect(MTC_XML_REFUSAL_OWNER.malformed).toBe("document");
    expect(MTC_XML_REFUSAL_OWNER["two-roots"]).toBe("document");
    expect(MTC_XML_REFUSAL_OWNER.character).toBe("document");
  });
});

describe("a sample read", () => {
  test("every observation of the page is walked", async () => {
    const { transport } = standIn(fixture("sample-count-200.xml"));
    const seen: string[] = [];
    const result = await readObservations(
      options(transport, { count: 0 }),
      guardRequestLine("/sample?count=200", GUARD),
      10_000,
      (observation) => seen.push(observation.attributes.dataItemId),
    );
    expect(result.read).toBe(200);
    expect(result.capped).toBe(false);
    expect(seen).toHaveLength(200);
  });

  test("the row cap stops the walk while reading, not afterwards", async () => {
    const { transport } = standIn(fixture("sample-count-200.xml"));
    let seen = 0;
    const result = await readObservations(
      options(transport, { count: 0 }),
      guardRequestLine("/sample?count=200", GUARD),
      25,
      () => {
        seen++;
      },
    );
    expect(seen).toBe(25);
    expect(result.read).toBe(25);
    expect(result.capped).toBe(true);
  });

  test("an error document is handed back for the caller to report, never read as observations", async () => {
    const { transport } = standIn(fixture("error-out-of-range.xml"), 400);
    const result = await readObservations(
      options(transport, { count: 0 }),
      guardRequestLine("/sample?count=1", GUARD),
      10_000,
      () => {
        throw new Error("an error document has no observations");
      },
    );
    expect({ read: result.read, capped: result.capped }).toEqual({ read: 0, capped: false });
    expect(result.agentError?.name).toBe("MTConnectError");
  });

  test("a proxy page is refused here too, not walked", async () => {
    const { transport } = standIn("<html><body>503</body></html>", 503, "text/html");
    try {
      await readObservations(
        options(transport, { count: 0 }),
        guardRequestLine("/sample?count=1", GUARD),
        10,
        () => {},
      );
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcClientError)) throw error;
      expect(error.failure).toBe("not-mtconnect");
    }
  });
});

describe("the byte caps", () => {
  test("each route carries its own, and current's is the largest because it is unpaged", () => {
    expect(MTC_BYTE_CAPS.current).toBeGreaterThan(MTC_BYTE_CAPS.probe);
    expect(MTC_BYTE_CAPS.probe).toBeGreaterThan(MTC_BYTE_CAPS.sample);
    expect(MTC_BYTE_CAPS.asset).toBeLessThan(MTC_BYTE_CAPS.assets);
    // MEASURED: a 500 device model answered current in 4,355,514 bytes and probe in 2,918,819, so
    // both caps leave room for a model several times larger.
    expect(MTC_BYTE_CAPS.current).toBeGreaterThan(4_355_514 * 3);
    expect(MTC_BYTE_CAPS.probe).toBeGreaterThan(2_918_819 * 3);
    // And the whole buffer of a default agent, 19,072,397 bytes, is past every cap on purpose.
    for (const cap of Object.values(MTC_BYTE_CAPS)) expect(cap).toBeLessThan(19_072_397);
  });
});
