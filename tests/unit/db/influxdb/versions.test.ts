/**
 * The InfluxDB version read and the per-generation table (InfluxDB spec 3.3, 6.2; R2, I10): the generation, the
 * reported version and the build from the `/ping` body or, when `/ping` has none, the `/health` body, and every
 * row of `GENERATION_TRAITS`.
 *
 * The answers under "measured" are the committed captures of the three pinned compose services (influxdb1 1.13.1,
 * influxdb2 2.9.1, influxdb3 3.12.0-core), read through tests/helpers/influxdb-fixtures.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  GENERATION_TRAITS,
  type InfluxGeneration,
  pingNeedsHealth,
  readPing,
} from "@/lib/db/providers/timeseries/influxdb/versions";
import { type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";

const UNKNOWN = { generation: "unknown", reported: null, build: null } as const;
const NO_CONTENT = { status: 204, text: "" };

/** A capture as `readPing` takes an answer: the status and the body. */
const answerOf = (version: InfluxFixtureVersion, name: string) => {
  const { status, body } = loadInfluxCapture(version, name);
  return { status, text: body };
};

const MEASURED = {
  v1: { ping: answerOf("1.13.1", "ping-auth"), health: answerOf("1.13.1", "health-auth") },
  v2: { ping: answerOf("2.9.1", "ping-auth"), health: answerOf("2.9.1", "health-auth") },
  v3: {
    ping: answerOf("3.12.0-core", "ping-auth"),
    /** What 3.x answers on `/health` behind the token: text, never read (spec 3.3). */
    health: answerOf("3.12.0-core", "health-auth"),
    /** `/ping` and `/health` with no token. */
    unauthenticated: answerOf("3.12.0-core", "ping-anon"),
  },
};

const ping = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
const health = (version: unknown, status = 200) => ({
  status,
  text: JSON.stringify({ name: "influxdb", status: "pass", version }),
});

describe("readPing over the measured answers of each line", () => {
  test("1.13.1: a bodiless /ping, then the /health version; no build is named", () => {
    expect(pingNeedsHealth(MEASURED.v1.ping)).toBe(true);
    expect(readPing(MEASURED.v1.ping, MEASURED.v1.health)).toEqual({
      generation: "v1",
      reported: "1.13.1",
      build: null,
    });
  });

  test("2.9.1: a bodiless /ping, then the /health version with its leading v", () => {
    expect(pingNeedsHealth(MEASURED.v2.ping)).toBe(true);
    expect(readPing(MEASURED.v2.ping, MEASURED.v2.health)).toEqual({
      generation: "v2",
      reported: "v2.9.1",
      build: null,
    });
  });

  test("3.12.0 Core: the /ping body decides alone, and /health is not needed", () => {
    expect(pingNeedsHealth(MEASURED.v3.ping)).toBe(false);
    expect(readPing(MEASURED.v3.ping)).toEqual({ generation: "v3", reported: "3.12.0", build: "Core" });
  });

  test("3.x: a /health handed in anyway is never read, its text OK included", () => {
    expect(readPing(MEASURED.v3.ping, MEASURED.v3.health)).toEqual({
      generation: "v3",
      reported: "3.12.0",
      build: "Core",
    });
    expect(readPing(MEASURED.v3.ping, MEASURED.v1.health)).toEqual({
      generation: "v3",
      reported: "3.12.0",
      build: "Core",
    });
  });

  test("3.x with no token: a 401 /ping names no version and asks for no /health", () => {
    expect(pingNeedsHealth(MEASURED.v3.unauthenticated)).toBe(false);
    expect(readPing(MEASURED.v3.unauthenticated)).toEqual(UNKNOWN);
    expect(readPing(MEASURED.v3.unauthenticated, MEASURED.v1.health)).toEqual(UNKNOWN);
  });
});

describe("readPing when no body is readable", () => {
  test("a bodiless /ping with no /health answer is unknown", () => {
    expect(readPing(NO_CONTENT)).toEqual(UNKNOWN);
  });

  test("a /health 401, which 1.x answers with ping-auth-enabled, is unknown and never a 1.x reading (R28)", () => {
    const refused = { status: 401, text: '{"error":"unable to parse authentication credentials"}' };
    expect(readPing(NO_CONTENT, refused)).toEqual(UNKNOWN);
    expect(readPing(NO_CONTENT, { status: 401, text: MEASURED.v1.health.text })).toEqual(UNKNOWN);
  });

  test.each([
    ["a 404", { status: 404, text: "404 page not found\n" }],
    ["a 503 that names a version", health("1.13.1", 503)],
    ["a 204", { status: 204, text: "" }],
    ["text", { status: 200, text: "OK" }],
    ["an empty body", { status: 200, text: "" }],
    ["an array", { status: 200, text: '["1.13.1"]' }],
    ["null", { status: 200, text: "null" }],
    ["a string", { status: 200, text: '"1.13.1"' }],
    ["an object with no version", { status: 200, text: '{"status":"pass"}' }],
    ["a version that is a number", health(1.13)],
    ["a version that is null", health(null)],
    ["a version that is an object", health({ major: 1 })],
  ])("a /health that is %s is unknown", (_name, answer) => {
    expect(readPing(NO_CONTENT, answer)).toEqual(UNKNOWN);
  });

  test.each([
    ["a 403 with a body", ping({ product_name: "InfluxDB 3 Core", version: "3.12.0" }, 403)],
    ["a 404", { status: 404, text: "Not Found" }],
    ["a 200 that is not JSON", { status: 200, text: "<html>proxy</html>" }],
    ["a 200 JSON array", { status: 200, text: "[]" }],
    ["a 200 with no version", ping({ product_name: "InfluxDB 3 Core" })],
  ])("a /ping that is %s is unknown, whatever /health says", (_name, answer) => {
    expect(readPing(answer)).toEqual(UNKNOWN);
    expect(readPing(answer, MEASURED.v2.health)).toEqual(UNKNOWN);
  });
});

describe("the reported version", () => {
  test.each([
    ["1.13.1", "v1"],
    ["1.8", "v1"],
    ["v1.11.8", "v1"],
    ["2.9.1", "v2"],
    ["v2.9.1", "v2"],
    ["v2.7.12-rc.1", "v2"],
    ["3.12.0", "v3"],
    ["3.0.0+build.7", "v3"],
    ["3.12.0.1", "v3"],
    ["0.13.0", "unknown"],
    ["4.0.0", "unknown"],
    ["10.2.3", "unknown"],
    ["13.1", "unknown"],
    ["v30.1", "unknown"],
  ] as const)("%s is repeated as written and is generation %s", (version, generation) => {
    expect(readPing(NO_CONTENT, health(version))).toEqual({ generation, reported: version, build: null });
  });

  test.each([
    "",
    "1",
    "v2",
    "1.",
    ".1.2",
    "V2.9.1",
    "vv2.9.1",
    "1.2.3.4.5",
    "12345.1",
    "1.1234567",
    "1.13.1 ",
    " 1.13.1",
    "1.13.1\n",
    "1.13.1-",
    "1.13.1-rc_1",
    "1.13.1 (the token is password)",
    `1.13.1-${"a".repeat(25)}`,
    "1.x",
    "one.two",
    "master",
    "١.١٣.١",
  ])("%j is never repeated and names no generation", (version) => {
    expect(readPing(NO_CONTENT, health(version))).toEqual(UNKNOWN);
    expect(readPing(ping({ product_name: "InfluxDB 3 Core", version }))).toEqual(UNKNOWN);
  });

  test("the longest suffix the rule repeats is 24 characters", () => {
    const version = `3.1.2-${"a".repeat(24)}`;
    expect(readPing(ping({ version }))).toEqual({ generation: "v3", reported: version, build: null });
  });

  test("a major written with leading zeros is read as its number", () => {
    expect(readPing(NO_CONTENT, health("01.8.0")).generation).toBe("v1");
    expect(readPing(NO_CONTENT, health("0003.1")).generation).toBe("v3");
    expect(readPing(NO_CONTENT, health("0.3.1")).generation).toBe("unknown");
  });

  test("a /ping body decides whatever generation it names", () => {
    expect(readPing(ping({ version: "1.13.1" }), MEASURED.v2.health)).toEqual({
      generation: "v1",
      reported: "1.13.1",
      build: null,
    });
  });
});

describe("the build", () => {
  test.each([
    ["InfluxDB 3 Core", "Core"],
    ["InfluxDB 3 Enterprise", "Enterprise"],
  ])("product_name %s is build %s", (product_name, build) => {
    expect(readPing(ping({ product_name, version: "3.12.0" }))).toEqual({
      generation: "v3",
      reported: "3.12.0",
      build,
    });
  });

  test.each([
    "InfluxDB 3 Cloud Dedicated",
    "InfluxDB 3 core",
    "InfluxDB 3 Core ",
    "InfluxDB 3 Core (the token is password)",
    "Core",
    "",
    "toString",
    "__proto__",
    7,
    null,
    // An array row is spread into arguments, so the array value is wrapped once more.
    [["InfluxDB 3 Core"]],
  ] as unknown[])("product_name %j names no build", (product_name) => {
    expect(readPing(ping({ product_name, version: "3.12.0" }))).toEqual({
      generation: "v3",
      reported: "3.12.0",
      build: null,
    });
  });

  test("a body with no product_name names no build", () => {
    expect(readPing(ping({ version: "3.12.0" }))).toEqual({ generation: "v3", reported: "3.12.0", build: null });
  });

  test("a /health body never names a build, even with a product_name", () => {
    const answer = { status: 200, text: JSON.stringify({ product_name: "InfluxDB 3 Core", version: "3.12.0" }) };
    expect(readPing(NO_CONTENT, answer)).toEqual({ generation: "v3", reported: "3.12.0", build: null });
  });

  test("a build is named only beside a version of generation v3", () => {
    expect(readPing(ping({ product_name: "InfluxDB 3 Core", version: "2.9.1" }))).toEqual({
      generation: "v2",
      reported: "2.9.1",
      build: null,
    });
    expect(readPing(ping({ product_name: "InfluxDB 3 Core" }))).toEqual(UNKNOWN);
  });
});

describe("pingNeedsHealth", () => {
  test.each([
    [204, "", true],
    [200, "", true],
    [200, "\n", true],
    [200, " \r\n", true],
    [200, "{}", false],
    [200, "OK", false],
    [204, "x", false],
    [401, "", false],
    [403, "", false],
    [404, "", false],
    [500, "", false],
    [301, "", false],
  ])("a /ping %d with the body %j: %p", (status, text, needed) => {
    expect(pingNeedsHealth({ status, text })).toBe(needed);
  });
});

describe("GENERATION_TRAITS", () => {
  test("is the table of spec 3.3, row for row", () => {
    expect(GENERATION_TRAITS).toEqual({
      v1: {
        label: "InfluxDB 1.x",
        errorEnvelope: "error-field",
        internalDatabase: "browse",
        servesSql: false,
        pingForbidden: "refused",
        tokenMeansUserPassword: true,
      },
      v2: {
        label: "InfluxDB 2.x",
        errorEnvelope: "code-message",
        internalDatabase: "hide",
        servesSql: false,
        pingForbidden: "refused",
        tokenMeansUserPassword: false,
      },
      v3: {
        label: "InfluxDB 3",
        errorEnvelope: "error-field-or-text",
        internalDatabase: "hide",
        servesSql: true,
        pingForbidden: "resource-token",
        tokenMeansUserPassword: false,
      },
      unknown: {
        label: "InfluxDB",
        errorEnvelope: "error-field-or-text",
        internalDatabase: "hide",
        servesSql: false,
        pingForbidden: "refused",
        tokenMeansUserPassword: false,
      },
    });
  });

  test("has a row for every generation readPing can answer, and is frozen at every depth", () => {
    const generations: InfluxGeneration[] = ["v1", "v2", "v3", "unknown"];
    expect(Object.keys(GENERATION_TRAITS).sort()).toEqual([...generations].sort());
    expect(Object.isFrozen(GENERATION_TRAITS)).toBe(true);
    for (const generation of generations) expect(Object.isFrozen(GENERATION_TRAITS[generation])).toBe(true);
  });

  test("only 1.x browses _internal, and an unknown server hides it (fail-closed)", () => {
    const browsing = Object.entries(GENERATION_TRAITS).filter(([, traits]) => traits.internalDatabase === "browse");
    expect(browsing.map(([generation]) => generation)).toEqual(["v1"]);
    expect(GENERATION_TRAITS.unknown.internalDatabase).toBe("hide");
  });
});
