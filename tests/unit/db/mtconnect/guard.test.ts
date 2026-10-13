/**
 * The route table and the phase 0 guard.
 *
 * Where a test asserts a refusal, the reason it names is the measured one: the route table comes
 * from the agent's own Swagger document, the path rules from cppagent's source and from the wire,
 * and the bounds from timings on a running agent.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCount,
  assertPathInSubset,
  assertSequence,
  guardRequestLine,
  MtcRefusal,
  type MtcWindow,
} from "@/lib/db/providers/industrial/mtconnect/guard";
import { MTC_REFUSED_KEYS, MTC_ROUTES, MTC_ROUTES_LEFT_OUT } from "@/lib/db/providers/industrial/mtconnect/routes";
import { indexMtconnectModel } from "@/lib/db/providers/industrial/mtconnect/model";
import { readMtconnectXml } from "@/lib/db/providers/industrial/mtconnect/xml";

const DIR = join(import.meta.dir, "../../../fixtures/mtconnect/2.8.0.3");

const WINDOW: MtcWindow = {
  instanceId: "1791206842",
  firstSequence: BigInt(29516471),
  lastSequence: BigInt(29647542),
  nextSequence: BigInt(29647543),
  bufferSize: BigInt(131072),
};
const OPTIONS = { window: WINDOW, rowCap: 10_000 };

/** The code of the refusal a call raises, or "accepted". */
function code(run: () => unknown): string {
  try {
    run();
    return "accepted";
  } catch (error) {
    if (error instanceof MtcRefusal) return error.code;
    throw error;
  }
}

describe("the route table", () => {
  test("nine routes, every one a GET that reads", () => {
    // Nine, not ten: the agent publishes no device scoped asset by id route. Counted from Swagger
    // row by row after an earlier draft of the table invented one by symmetry.
    expect(MTC_ROUTES.length).toBe(9);
    expect(MTC_ROUTES.every((route) => route.method === "GET")).toBe(true);
    expect(MTC_ROUTES.every((route) => route.reads === true)).toBe(true);
  });

  test("the routes left out are named with their reasons, and nine plus six is the published fifteen", () => {
    expect(MTC_ROUTES_LEFT_OUT.map((entry) => entry.route).sort()).toEqual([
      "/",
      "/asset",
      "/assets/{assetIds}",
      "/cancel/id={string}",
      "/swagger",
      "/{device}",
      "/{device}/asset",
    ]);
    // Six of those seven are among the agent's fifteen; /swagger is not one of them.
    const published = MTC_ROUTES_LEFT_OUT.filter((entry) => entry.route !== "/swagger");
    expect(MTC_ROUTES.length + published.length).toBe(15);
    expect(MTC_ROUTES_LEFT_OUT.every((entry) => entry.why.length > 40)).toBe(true);
  });

  test("the asset by id route takes the ids and nothing else, as Swagger says", () => {
    // The issue groups `assets` and `asset` under one parameter list. The agent does not.
    for (const route of MTC_ROUTES.filter((candidate) => candidate.op === "asset")) {
      expect(Object.keys(route.query)).toEqual([]);
      expect(Object.keys(route.params)).toContain("assetIds");
    }
    for (const route of MTC_ROUTES.filter((candidate) => candidate.op === "assets")) {
      expect(Object.keys(route.query).sort()).toEqual(["count", "removed", "type"]);
    }
  });

  test("device is a refused query key, with the measurement as its reason", () => {
    expect(MTC_REFUSED_KEYS.device).toContain("every asset in the buffer");
    expect(Object.keys(MTC_REFUSED_KEYS).sort()).toEqual([
      "device",
      "format",
      "frequency",
      "heartbeat",
      "interval",
      "pretty",
    ]);
  });
});

describe("the request line", () => {
  test("every route of the table parses, with and without a device", () => {
    const devices = new Set(["Mazak"]);
    const lines = [
      "/probe",
      "/Mazak/probe",
      "/current",
      "/Mazak/current",
      "/sample",
      "/Mazak/sample",
      "/assets",
      "/Mazak/assets",
      "/asset/OLCUM.1",
    ];
    for (const line of lines) {
      const request = guardRequestLine(line, { ...OPTIONS, knownDevices: devices });
      expect(request.route.method).toBe("GET");
    }
    expect(new Set(lines.map((line) => guardRequestLine(line, { ...OPTIONS, knownDevices: devices }).op)).size).toBe(5);
  });

  test("a bare device and a bare slash are not routes, because the aliases are out", () => {
    expect(code(() => guardRequestLine("/", OPTIONS))).toBe("unknown-route");
    expect(code(() => guardRequestLine("/Mazak", { ...OPTIONS, knownDevices: new Set(["Mazak"]) }))).toBe(
      "unknown-route",
    );
    expect(code(() => guardRequestLine("/asset", OPTIONS))).toBe("unknown-route");
    expect(code(() => guardRequestLine("/cancel/id=x", OPTIONS))).toBe("unknown-route");
    expect(code(() => guardRequestLine("/swagger", OPTIONS))).toBe("unknown-route");
  });

  test("an asset id is read without a device, because the agent publishes no device scoped id route", () => {
    const devices = new Set(["Mazak"]);
    expect(guardRequestLine("/asset/OLCUM.1", OPTIONS).params.assetIds).toBe("OLCUM.1");
    expect(code(() => guardRequestLine("/Mazak/asset/OLCUM.1", { ...OPTIONS, knownDevices: devices }))).toBe(
      "unknown-route",
    );
    // The device scoped asset routes the agent does publish are aliases of each other, and both are out.
    expect(code(() => guardRequestLine("/Mazak/asset", { ...OPTIONS, knownDevices: devices }))).toBe("unknown-route");
    expect(guardRequestLine("/Mazak/assets", { ...OPTIONS, knownDevices: devices }).op).toBe("assets");
  });

  test("a trailing slash is refused rather than trimmed", () => {
    expect(code(() => guardRequestLine("/probe/", OPTIONS))).toBe("trailing-slash");
    expect(code(() => guardRequestLine("/Mazak/current/", { ...OPTIONS, knownDevices: new Set(["Mazak"]) }))).toBe(
      "trailing-slash",
    );
  });

  test("a leading GET is allowed and any other method is refused by name", () => {
    expect(guardRequestLine("GET /probe", OPTIONS).op).toBe("probe");
    for (const method of ["PUT", "POST", "DELETE", "HEAD", "OPTIONS"]) {
      expect(code(() => guardRequestLine(`${method} /probe`, OPTIONS))).toBe("method");
    }
  });

  test("a scheme, a host and a fragment are refused", () => {
    expect(code(() => guardRequestLine("http://other/probe", OPTIONS))).toBe("absolute-url");
    expect(code(() => guardRequestLine("//other/probe", OPTIONS))).toBe("absolute-url");
    expect(code(() => guardRequestLine("/probe#top", OPTIONS))).toBe("fragment");
  });

  test("an unknown device is refused before any request, from the held model", () => {
    const read = readMtconnectXml(new Uint8Array(readFileSync(join(DIR, "probe.xml"))));
    if (!read.ok) throw new Error(read.reason);
    const model = indexMtconnectModel(read.root);
    if (model === undefined) throw new Error("no model");
    const known = new Set(model.devices.flatMap((device) => [device.name, device.uuid]));
    expect(guardRequestLine("/Mazak/current", { ...OPTIONS, knownDevices: known }).op).toBe("current");
    expect(guardRequestLine("/OKUMA.123456/current", { ...OPTIONS, knownDevices: known }).op).toBe("current");
    expect(code(() => guardRequestLine("/NoSuchDevice/current", { ...OPTIONS, knownDevices: known }))).toBe(
      "unknown-device",
    );
  });
});

describe("parameters", () => {
  test("each route takes only its own keys", () => {
    expect(guardRequestLine("/sample?count=5", OPTIONS).query.count).toBe("5");
    // MEASURED: the agent ignores count on current, so the provider refuses it instead.
    expect(code(() => guardRequestLine("/current?count=2", OPTIONS))).toBe("unknown-key");
    expect(code(() => guardRequestLine("/probe?path=//DataItem", OPTIONS))).toBe("unknown-key");
    expect(code(() => guardRequestLine("/asset/A.1?type=CuttingTool", OPTIONS))).toBe("unknown-key");
  });

  test("the five streaming and formatting keys are refused by name", () => {
    for (const key of ["interval", "heartbeat", "frequency", "format", "pretty"]) {
      expect(code(() => guardRequestLine(`/sample?${key}=1`, OPTIONS))).toBe("refused-key");
    }
  });

  test("device as a query key is refused even on the route that accepts it", () => {
    expect(code(() => guardRequestLine("/assets?device=Mazak", OPTIONS))).toBe("refused-key");
  });

  test("a repeated key is refused, because the agent would drop one silently", () => {
    expect(code(() => guardRequestLine("/sample?count=1&count=5", OPTIONS))).toBe("repeated-key");
  });

  test("removed takes true or false", () => {
    expect(guardRequestLine("/assets?removed=true", OPTIONS).query.removed).toBe("true");
    expect(code(() => guardRequestLine("/assets?removed=yes", OPTIONS))).toBe("bad-boolean");
  });
});

describe("sequence numbers and count", () => {
  test("a sequence number is decimal and inside 1 to 2^64 - 1", () => {
    expect(assertSequence("from", "29516471", WINDOW)).toBe(BigInt(29516471));
    expect(code(() => assertSequence("from", "0"))).toBe("bad-sequence");
    expect(code(() => assertSequence("from", "-1"))).toBe("bad-sequence");
    expect(code(() => assertSequence("from", "abc"))).toBe("bad-sequence");
    expect(code(() => assertSequence("from", "1.5"))).toBe("bad-sequence");
    expect(assertSequence("from", "18446744073709551615")).toBe(BigInt("18446744073709551615"));
    expect(code(() => assertSequence("from", "18446744073709551616"))).toBe("bad-sequence");
  });

  test("a from below the window says how many observations were lost", () => {
    try {
      assertSequence("from", "29516000", WINDOW);
      throw new Error("should have refused");
    } catch (error) {
      if (!(error instanceof MtcRefusal)) throw error;
      expect(error.code).toBe("window");
      expect(error.message).toContain("471 observations were lost");
    }
  });

  test("a from at nextSequence is accepted, because that is how nothing new is asked", () => {
    expect(assertSequence("from", "29647543", WINDOW)).toBe(BigInt(29647543));
    expect(code(() => assertSequence("from", "29647544", WINDOW))).toBe("window");
  });

  test("count is a non zero integer and may be negative", () => {
    expect(assertCount("100", WINDOW, 10_000)).toBe(100);
    expect(assertCount("-3", WINDOW, 10_000)).toBe(-3);
    expect(code(() => assertCount("0", WINDOW, 10_000))).toBe("bad-count");
    expect(code(() => assertCount("1.5", WINDOW, 10_000))).toBe("bad-count");
    expect(code(() => assertCount("abc", WINDOW, 10_000))).toBe("bad-count");
    expect(code(() => assertCount("200000", WINDOW, 10_000))).toBe("bad-count");
    expect(code(() => assertCount("20000", WINDOW, 10_000))).toBe("bad-count");
  });

  test("to may not be below from", () => {
    expect(code(() => guardRequestLine("/sample?from=29516500&to=29516400", OPTIONS))).toBe("window");
    expect(guardRequestLine("/sample?from=29516500&to=29516600", OPTIONS).query.to).toBe("29516600");
  });
});

describe("the path subset", () => {
  test("the constructs measured as accepted are accepted", () => {
    for (const path of [
      '//DataItem[@type="POSITION"]',
      '//DataItem[@type="POSITION" and @subType="ACTUAL"]',
      '//DataItem[@type="POSITION" or @type="LOAD"]',
      "//Axes",
      '//Linear[@name="X"]//DataItem',
      '//DataItem[@category="CONDITION"]',
      '//DataItem[starts-with(@id,"d1-")]',
      '//DataItem[contains(@name,"pos")]',
      '//m:DataItem[@category="SAMPLE"]',
      "/MTConnectDevices/Devices/Device/DataItems/DataItem",
    ]) {
      expect(code(() => assertPathInSubset(path))).toBe("accepted");
    }
  });

  test("an attribute step is refused, because the agent rewrites it into m:@id", () => {
    expect(code(() => assertPathInSubset("//DataItem/@id"))).toBe("path-attribute-step");
  });

  test("a slash or a bar inside a quoted value is refused", () => {
    expect(code(() => assertPathInSubset('//DataItem[@name="a/b"]'))).toBe("path-literal");
    expect(code(() => assertPathInSubset('//DataItem[@name="a|b"]'))).toBe("path-literal");
    expect(code(() => assertPathInSubset("//DataItem[@name='a/b']"))).toBe("path-literal");
  });

  test("a path inside a predicate is refused", () => {
    expect(code(() => assertPathInSubset("//DataItem[../@id]"))).toBe("path-predicate-path");
  });

  test("a function outside the list is refused by name", () => {
    expect(code(() => assertPathInSubset("//DataItem[position()=1]"))).toBe("path-function");
    expect(code(() => assertPathInSubset("//DataItem[last()]"))).toBe("path-function");
    expect(code(() => assertPathInSubset('//DataItem[substring(@id,1,2)="d1"]'))).toBe("path-function");
  });

  test("too many alternatives are refused, with the cost as the reason", () => {
    const many = `//DataItem[${Array.from({ length: 40 }, (_, index) => `@id="d${index}"`).join(" or ")}]`;
    const refusal = code(() => assertPathInSubset(many));
    expect(refusal).toBe("path-too-many-alternatives");
  });

  test("an empty or unclosed path is refused", () => {
    expect(code(() => assertPathInSubset("   "))).toBe("path-syntax");
    expect(code(() => assertPathInSubset('//DataItem[@name="a'))).toBe("path-syntax");
  });

  test("an oversized path is refused before any request", () => {
    expect(code(() => assertPathInSubset(`//DataItem[@id="${"x".repeat(5000)}"]`))).toBe("path-too-long");
  });

  test("a path that passes the subset reaches the request unchanged", () => {
    const path = '//DataItem[@category="CONDITION"]';
    expect(guardRequestLine(`/current?path=${encodeURIComponent(path)}`, OPTIONS).query.path).toBe(path);
  });
});

/**
 * The comment lines the dialect promises (#1722).
 *
 * MTC_CONSOLE_DIALECT declares `#` as a comment marker, so the editor draws a `#` line as a comment
 * and the tree's generator writes one above the request it builds. Before this the whole text went
 * into the `#` rule and every such request was refused as carrying a fragment, which is a sentence
 * about a URL and not about a comment. Found by writing the generator, not by reading the guard.
 */
describe("comment lines above the request", () => {
  test("a comment line is dropped and the request below it runs", () => {
    const request = guardRequestLine("# PART_COUNT on Mazak\nGET /Mazak/current", {
      ...OPTIONS,
      knownDevices: new Set(["Mazak"]),
    });
    expect([request.op, request.params.device]).toEqual(["current", "Mazak"]);
  });

  test("several comment lines and blank lines are dropped", () => {
    const request = guardRequestLine("# one\n\n#two\n\nGET /probe", OPTIONS);
    expect(request.op).toBe("probe");
  });

  test("a # after the route is still a fragment", () => {
    expect(code(() => guardRequestLine("GET /probe#top", OPTIONS))).toBe("fragment");
  });

  test("two request lines are refused as two, not run as the first", () => {
    expect(code(() => guardRequestLine("GET /probe\nGET /current", OPTIONS))).toBe("two-requests");
  });

  test("a text of only comments is refused for having no route", () => {
    expect(code(() => guardRequestLine("# nothing here\n", OPTIONS))).toBe("unknown-route");
  });
});
