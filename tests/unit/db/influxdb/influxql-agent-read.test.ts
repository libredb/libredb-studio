/**
 * The `influxdb` agent read-only profile's own rules (`influxql-agent-read.ts`): the proof that the principal reads
 * only, replayed from what 1.13.1 and 2.9.1 answered each principal (tests/fixtures/influxdb/<version>/agent-boundary/),
 * the response cap taken from the byte budget, the strict shaping of an answer, and the budget refusals a failed
 * request becomes.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { InfluxAnswer, InfluxRequest } from "@/lib/db/providers/timeseries/influxdb/client";
import {
  INFLUXQL_AGENT_ENVELOPE_ALLOWANCE_BYTES,
  INFLUXQL_AGENT_PROBED_DATABASES,
  INFLUXQL_AGENT_WIRE_EXPANSION,
  influxqlAgentReadFailure,
  influxqlAgentResponseCap,
  proveInfluxqlAgentPrincipal,
  shapeInfluxqlAgentAnswer,
  writeProbeStatement,
} from "@/lib/db/providers/timeseries/influxdb/influxql-agent-read";
import type { InfluxqlRouteId } from "@/lib/db/providers/timeseries/influxdb/routes";
import type { InfluxGeneration } from "@/lib/db/providers/timeseries/influxdb/versions";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { type InfluxCapture, type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 3, maxResultBytes: 1_000 };
const NONCE = "0123456789abcdef";
const PROBE = 'DELETE FROM "libredb_agent_probe_0123456789abcdef" WHERE time < 0';

const at = (version: InfluxFixtureVersion, name: string): InfluxCapture =>
  loadInfluxCapture(version, `agent-boundary/${name}`);

function answer(status: number, body: string): InfluxAnswer {
  return { status, contentType: "application/json", text: body };
}

const asAnswer = (capture: InfluxCapture): InfluxAnswer => answer(capture.status, capture.body);

/** A proof over scripted answers, with every request it sent. */
async function prove(
  generation: InfluxGeneration,
  script: readonly (InfluxCapture | InfluxAnswer | Error)[],
  options: { database?: string | undefined; hasUser?: boolean } = {},
): Promise<{ error: Error | undefined; sent: InfluxRequest<InfluxqlRouteId>[] }> {
  const sent: InfluxRequest<InfluxqlRouteId>[] = [];
  let next = 0;
  const signal = new AbortController().signal;
  try {
    await proveInfluxqlAgentPrincipal({
      send: async (request, given) => {
        expect(given).toBe(signal);
        sent.push(request);
        const scripted = script[next++];
        if (scripted === undefined) throw new Error(`nothing scripted for ${request.values.q}`);
        if (scripted instanceof Error) throw scripted;
        return "version" in scripted ? asAnswer(scripted) : scripted;
      },
      signal,
      generation,
      database: "database" in options ? options.database : "home",
      hasUser: options.hasUser ?? true,
      nonce: NONCE,
    });
    expect(next).toBe(script.length);
    return { error: undefined, sent };
  } catch (error) {
    return { error: error as Error, sent };
  }
}

function profileError(error: Error | undefined, code: string): ExecutionProfileError {
  expect(error).toBeInstanceOf(ExecutionProfileError);
  expect((error as ExecutionProfileError).reasonCode).toBe(code as ExecutionProfileError["reasonCode"]);
  return error as ExecutionProfileError;
}

const USERS = { route: "query-unchunked", values: { q: "SHOW USERS" } };
const LISTING = { route: "query-unchunked", values: { q: "SHOW DATABASES" } };
const probeOn = (db: string) => ({ route: "query-unchunked", values: { db, q: PROBE } });

describe("writeProbeStatement", () => {
  test("deletes from a measurement named for this probe alone, before any point there can be", () => {
    expect(writeProbeStatement(NONCE)).toBe(PROBE);
  });

  test("refuses a nonce that is not lower-case hex, so no text reaches the statement", () => {
    expect(() => writeProbeStatement('x" WHERE true; DROP')).toThrow("hex");
  });
});

describe("proveInfluxqlAgentPrincipal on 1.13.1", () => {
  test("admits a user with READ on the bound database only: SHOW USERS refused, the no-op DELETE refused", async () => {
    const { error, sent } = await prove("v1", [
      at("1.13.1", "admin-read-reader"),
      at("1.13.1", "listing-reader"),
      at("1.13.1", "write-probe-reader-home"),
    ]);
    expect(error).toBeUndefined();
    expect(sent).toEqual([USERS, LISTING, probeOn("home")]);
  });

  test("refuses a user that also holds WRITE on a second database, the one 1.13.1 lets SELECT ... INTO write", async () => {
    const { error, sent } = await prove("v1", [
      at("1.13.1", "admin-read-rw"),
      at("1.13.1", "listing-rw"),
      at("1.13.1", "write-probe-rw-home"),
      at("1.13.1", "write-probe-rw-other"),
    ]);
    expect(sent).toEqual([USERS, LISTING, probeOn("home"), probeOn("other")]);
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_BROAD").message).toBe(
      'The agent read-only profile needs a principal that writes nothing, and this one can write the database "other": InfluxDB 1.x answered a no-op DELETE there. Use a user granted READ only. Nothing else was sent.',
    );
    // What it would write: the same user's SELECT ... INTO that database was answered, and wrote.
    expect(at("1.13.1", "into-second-rw").body).toContain('"written"');
    expect(at("1.13.1", "into-state-other-after-rw").body).toContain("libredb_into");
  });

  test("refuses an admin by its SHOW USERS answer, before anything else is sent", async () => {
    const { error, sent } = await prove("v1", [at("1.13.1", "admin-read-admin")]);
    expect(sent).toEqual([USERS]);
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_BROAD").message).toBe(
      "The agent read-only profile needs a principal that is not an administrator, and InfluxDB 1.x answered this one SHOW USERS. Use a user granted READ only. Nothing else was sent.",
    );
  });

  test("refuses a server with authentication off, which answers SHOW USERS to no credential", async () => {
    const { error } = await prove("v1", [at("1.13.1", "admin-read-auth-off")], { hasUser: false });
    expect(profileError(error, "PROFILE_SERVER_UNENFORCED").message).toBe(
      "The agent read-only profile needs a server that checks who asks, and InfluxDB 1.x answered SHOW USERS to a connection with no credential: its authentication is off. Turn on [http] auth-enabled and connect as a user granted READ only. Nothing else was sent.",
    );
    // The same server ran the no-op DELETE for no one.
    expect(at("1.13.1", "write-probe-auth-off-home").status).toBe(200);
  });

  test("refuses an admin read answered in any other way, fail closed", async () => {
    for (const body of ['{"error":"error authorizing query: reader not authorized"}', "not json"]) {
      const { error } = await prove("v1", [answer(403, body)]);
      expect(profileError(error, "PROFILE_UNSUPPORTED_TARGET").message).toBe(
        "The agent read-only profile could not read InfluxDB 1.x's answer to SHOW USERS, so this principal is not proved read-only and is refused. Nothing else was sent.",
      );
    }
    const { error } = await prove("v1", [answer(500, '{"error":"boom"}')]);
    profileError(error, "PROFILE_UNSUPPORTED_TARGET");
  });

  test("refuses a write probe answered in any other way, fail closed", async () => {
    for (const reply of [
      answer(403, '{"error":"error authorizing query: reader not authorized to execute statement, requires WRITE on edge"}'),
      answer(200, '{"results":[{"statement_id":0,"error":"database not found: home"}]}'),
      answer(500, "boom"),
    ]) {
      const { error } = await prove("v1", [at("1.13.1", "admin-read-reader"), at("1.13.1", "listing-reader"), reply]);
      expect(profileError(error, "PROFILE_UNSUPPORTED_TARGET").message).toBe(
        'The agent read-only profile could not read InfluxDB 1.x\'s answer to a no-op DELETE on the database "home", so this principal is not proved read-only and is refused. Nothing else was sent.',
      );
    }
  });
});

describe("proveInfluxqlAgentPrincipal on 2.9.1", () => {
  test("admits a token that reads the bound bucket only: no admin statement exists, the no-op DELETE is refused", async () => {
    // SHOW USERS proves nothing on this line: every token is answered "not implemented", the operator's included.
    expect(at("2.9.1", "admin-read-operator").body).toContain("not implemented: SHOW USERS");
    const { error, sent } = await prove("v2", [at("2.9.1", "listing-ro"), at("2.9.1", "write-probe-ro-home")]);
    expect(error).toBeUndefined();
    expect(sent).toEqual([LISTING, probeOn("home")]);
  });

  test("refuses the operator token by the system buckets it lists, before any probe", async () => {
    const { error, sent } = await prove("v2", [at("2.9.1", "listing-operator")]);
    expect(sent).toEqual([LISTING]);
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_BROAD").message).toBe(
      "The agent read-only profile needs a token scoped to the buckets it reads, and this one lists InfluxDB 2.x's system buckets, which only an operator or all-access token reads. Use a token with read permission on the connection's bucket. Nothing else was sent.",
    );
  });

  test("refuses a token that writes the bound bucket", async () => {
    const { error } = await prove("v2", [at("2.9.1", "listing-ro"), at("2.9.1", "write-probe-rwhome-home")]);
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_BROAD").message).toContain(
      'this one can write the database "home": InfluxDB 2.x answered a no-op DELETE there',
    );
  });

  test("refuses a token that writes a second bucket it lists", async () => {
    const { error, sent } = await prove("v2", [
      at("2.9.1", "listing-readother"),
      at("2.9.1", "write-probe-rwother-home"),
      at("2.9.1", "write-probe-readother-other"),
    ]);
    expect(sent).toEqual([LISTING, probeOn("home"), probeOn("other")]);
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_BROAD").message).toContain('can write the database "other"');
  });

  test("a token's write on a bucket it does not list is out of InfluxQL's reach: no DELETE and no INTO lands there", () => {
    expect(at("2.9.1", "listing-rwother").body).not.toContain('"other"');
    expect(at("2.9.1", "write-probe-rwother-other").body).toContain("no dbrp mappings found");
    for (const principal of ["ro", "rwother", "readother", "operator"]) {
      expect(at("2.9.1", `into-bound-${principal}`).body).toContain("not implemented: SELECT INTO");
      expect(at("2.9.1", `into-second-${principal}`).body).toMatch(/not implemented: SELECT INTO|database not found/);
    }
    expect(at("2.9.1", "into-state-other-after").body).not.toContain("libredb_into");
  });
});

describe("proveInfluxqlAgentPrincipal on every line", () => {
  test.each(["v3", "unknown"] as const)("refuses %s before anything is sent", async (generation) => {
    const { error, sent } = await prove(generation, []);
    expect(sent).toEqual([]);
    expect(profileError(error, "PROFILE_UNSUPPORTED_TARGET").message).toBe(
      generation === "v3"
        ? "The agent read-only profile reads InfluxQL on InfluxDB 1.x and 2.x, where a principal can be proved read-only, and this server is InfluxDB 3: connect it as InfluxDB 3 (SQL), whose agent path is measured on its own."
        : "The agent read-only profile reads InfluxQL on InfluxDB 1.x and 2.x, where a principal can be proved read-only, and this server names no version Studio can place, so it is refused.",
    );
  });

  test("refuses a connection that names no database, before anything is sent", async () => {
    const { error, sent } = await prove("v1", [], { database: undefined });
    expect(sent).toEqual([]);
    expect(profileError(error, "PROFILE_UNSUPPORTED_TARGET").message).toBe(
      "The agent read-only profile reads the connection's database, and this connection names none: set Database on the connection.",
    );
  });

  test("refuses a principal that does not list the bound database", async () => {
    const { error } = await prove("v1", [at("1.13.1", "admin-read-reader"), at("1.13.1", "listing-reader")], {
      database: "edge",
    });
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_NARROW").message).toBe(
      'The agent read-only profile reads the connection\'s database "edge", and InfluxDB 1.x does not list it for this principal: grant it READ there. Nothing else was sent.',
    );
  });

  test("refuses a principal that lists more databases than the proof probes", async () => {
    const names = Array.from({ length: INFLUXQL_AGENT_PROBED_DATABASES + 1 }, (_, index) => [`db${index}`]);
    const listing = answer(
      200,
      JSON.stringify({ results: [{ statement_id: 0, series: [{ name: "databases", columns: ["name"], values: names }] }] }),
    );
    const { error } = await prove("v2", [listing], { database: "db0" });
    expect(profileError(error, "PROFILE_PRIVILEGES_TOO_BROAD").message).toBe(
      `The agent read-only profile proves a principal read-only on every database it lists, at most ${INFLUXQL_AGENT_PROBED_DATABASES}, and InfluxDB 2.x lists more for this one: scope it to fewer databases. Nothing else was sent.`,
    );
  });

  test("refuses a listing it cannot read, fail closed", async () => {
    for (const reply of [answer(200, "not json"), answer(401, '{"code":"unauthorized"}')]) {
      const { error } = await prove("v2", [reply]);
      expect(profileError(error, "PROFILE_UNSUPPORTED_TARGET").message).toBe(
        "The agent read-only profile could not read InfluxDB 2.x's answer to SHOW DATABASES, so this principal is not proved read-only and is refused. Nothing else was sent.",
      );
    }
  });

  test("a failure to reach the server leaves as it came", async () => {
    const failure = new TransportError("timeout", "The request did not finish within its time limit");
    const { error } = await prove("v1", [failure]);
    expect(error).toBe(failure);
  });
});

describe("the response cap and the budget refusals", () => {
  test("the cap is the byte budget times the wire's widest escape, plus room for an error", () => {
    expect(INFLUXQL_AGENT_WIRE_EXPANSION).toBe(6);
    expect(INFLUXQL_AGENT_ENVELOPE_ALLOWANCE_BYTES).toBe(64 * 1024);
    expect(influxqlAgentResponseCap(BUDGET)).toBe(6_000 + 64 * 1024);
  });

  test("an answer past the cap and a request past its deadline are the shared refusals; anything else is not", () => {
    const tooLarge = influxqlAgentReadFailure(new TransportError("too-large", "x"), BUDGET, "SELECT 1");
    expect(tooLarge).toBeInstanceOf(QueryError);
    expect(tooLarge?.message).toBe(
      `Read-only execution exceeded the byte budget: ${influxqlAgentResponseCap(BUDGET) + 1} bytes > 1000 allowed`,
    );
    const late = influxqlAgentReadFailure(new TransportError("timeout", "x"), BUDGET, "SELECT 1");
    expect(late?.message).toBe("Read-only execution exceeded the time budget: no answer within 5000ms");
    expect(influxqlAgentReadFailure(new TransportError("network", "x"), BUDGET, "SELECT 1")).toBeUndefined();
    expect(influxqlAgentReadFailure(new Error("x"), BUDGET, "SELECT 1")).toBeUndefined();
  });
});

describe("shapeInfluxqlAgentAnswer", () => {
  const rows = (count: number, columns = ["time", "v"]) =>
    JSON.stringify({
      results: [
        {
          statement_id: 0,
          series: [{ name: "m", columns, values: Array.from({ length: count }, (_, index) => [index, index]) }],
        },
      ],
    });

  test("answers the rows within the budget, with the server's notices", () => {
    expect(shapeInfluxqlAgentAnswer(rows(3), BUDGET, [], "SELECT * FROM m")).toEqual({
      fields: ["time", "v"],
      rows: [
        { time: 0, v: 0 },
        { time: 1, v: 1 },
        { time: 2, v: 2 },
      ],
      warnings: [],
    });
  });

  test("refuses a result past the row budget rather than cut it", () => {
    const error = (() => {
      try {
        shapeInfluxqlAgentAnswer(rows(4), BUDGET, [], "SELECT * FROM m");
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toBe("Read-only execution exceeded the row budget: 4 rows > 3 allowed");
  });

  test("refuses rows past the byte budget", () => {
    const wide = JSON.stringify({
      results: [{ statement_id: 0, series: [{ name: "m", columns: ["s"], values: [["x".repeat(2_000)]] }] }],
    });
    expect(() => shapeInfluxqlAgentAnswer(wide, BUDGET, [], "SELECT s FROM m")).toThrow(
      /^Read-only execution exceeded the byte budget: \d+ bytes > 1000 allowed$/,
    );
  });

  test("refuses rows the cell budget cuts, as past the rows the budget allows", () => {
    const columns = Array.from({ length: 100_000 }, (_, index) => `c${index}`);
    const body = JSON.stringify({
      results: [
        {
          statement_id: 0,
          series: [{ name: "m", columns, values: [columns.map(() => 0), columns.map(() => 0), columns.map(() => 0)] }],
        },
      ],
    });
    expect(() =>
      shapeInfluxqlAgentAnswer(body, { ...BUDGET, maxResultBytes: 100_000_000 }, [], "SELECT * FROM m"),
    ).toThrow("Read-only execution exceeded the row budget: 3 rows > 2 allowed");
  });

  test("an answer the server words as an error stays the shaper's error", () => {
    const refused = '{"results":[{"statement_id":0,"error":"insufficient permissions"}]}';
    expect(() => shapeInfluxqlAgentAnswer(refused, BUDGET, [], "SELECT 1")).toThrow();
  });
});
