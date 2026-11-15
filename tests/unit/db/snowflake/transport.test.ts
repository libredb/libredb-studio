import { describe, expect, test } from "bun:test";
import { httpOrigin } from "@/lib/db/http/endpoint";
import { TransportError } from "@/lib/db/http/node-transport";
import { patTokenSource, readAccessToken, SNOWFLAKE_TOKEN_MAX_CHARS } from "@/lib/db/providers/sql/snowflake/auth";
import {
  createSnowflakeTransport,
  SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES,
  SNOWFLAKE_RETRY_ATTEMPTS,
  SNOWFLAKE_RETRY_BASE_MS,
  SNOWFLAKE_RETRY_MAX_MS,
  SNOWFLAKE_USER_AGENT,
  snowflakeBackoffMs,
  snowflakeProductionDeps,
} from "@/lib/db/providers/sql/snowflake/transport";
import {
  deferredAnswer,
  fakeClock,
  type ScriptedAnswer,
  scriptedTokens,
  scriptedTransports,
  snowflakeTestUuid,
  testDeps,
} from "../../../helpers/snowflake-node-transport";
import { closeAll, rawAnswer, rawHttpListener } from "../../../helpers/node-transport-fixtures";

const HOST = "acme-x1.snowflakecomputing.com";
const ORIGIN = httpOrigin("https", HOST, 443);
const TLS = { rejectUnauthorized: true, identity: HOST } as const;
const STATEMENTS = "/api/v2/statements";
const HANDLE = "019c06a4-0000-df4f-0000-00100006589e";
const STATUS = `${STATEMENTS}/${HANDLE}`;
const MAX = SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES;

function setup(
  tokens = scriptedTokens(["t1", "t2", "t3"]),
  tls: { readonly rejectUnauthorized: boolean; readonly identity: string } | null = TLS,
) {
  const transports = scriptedTransports();
  const clock = fakeClock();
  const deps = testDeps(transports, clock);
  const transport = createSnowflakeTransport({ origin: ORIGIN, tls, tokens }, deps);
  return { transports, clock, deps, tokens, transport };
}

const signal = () => new AbortController().signal;
const ok = (json: unknown = {}): ScriptedAnswer => ({ status: 200, json });
const bytesOk = (text = "[]"): ScriptedAnswer => ({ status: 200, bytes: Buffer.from(text) });

describe("constants", () => {
  test("the retry values, the control cap and the user agent", () => {
    expect(SNOWFLAKE_RETRY_BASE_MS).toBe(500);
    expect(SNOWFLAKE_RETRY_MAX_MS).toBe(8_000);
    expect(SNOWFLAKE_RETRY_ATTEMPTS).toBe(5);
    expect(SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES).toBe(1_048_576);
    expect(SNOWFLAKE_USER_AGENT).toMatch(/^LibreDB-Studio(\/.+)?$/);
  });

  test("the backoff doubles from the base, jittered to half or the whole, and is capped", () => {
    expect(snowflakeBackoffMs(1, 0.5)).toBe(375);
    expect(snowflakeBackoffMs(1, 0)).toBe(250);
    expect(snowflakeBackoffMs(1, 1)).toBe(500);
    expect(snowflakeBackoffMs(2, 0.5)).toBe(750);
    expect(snowflakeBackoffMs(5, 1)).toBe(8_000);
    expect(snowflakeBackoffMs(9, 1)).toBe(8_000);
    expect(snowflakeBackoffMs(9, 0)).toBe(4_000);
  });
});

describe("snowflakeProductionDeps", () => {
  test("the shared transports, the clock, random, UUIDs and timeout signals", async () => {
    const deps = snowflakeProductionDeps();
    expect(typeof deps.createNodeTransport).toBe("function");
    expect(typeof deps.createNodeByteTransport).toBe("function");
    expect(Math.abs(deps.now() - Date.now())).toBeLessThan(1000);
    const value = deps.random();
    expect(value >= 0 && value < 1).toBe(true);
    expect(deps.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const deadline = deps.deadline(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deadline.aborted).toBe(true);
    expect((deadline.reason as DOMException).name).toBe("TimeoutError");
  });

  test("sleep waits its time, and rejects with the reason when the signal aborts or had aborted", async () => {
    const { sleep } = snowflakeProductionDeps();
    const started = Date.now();
    await sleep(20, signal());
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);

    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");

    await expect(sleep(10, controller.signal)).rejects.toThrow("stop");
  });
});

describe("headers and transport options", () => {
  for (const tokenType of ["KEYPAIR_JWT", "PROGRAMMATIC_ACCESS_TOKEN"] as const) {
    test(`a submit under ${tokenType} carries exactly the four headers`, async () => {
      const { transports, transport } = setup(scriptedTokens(["tok"], tokenType));
      transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, ok());
      await transport.submit(STATEMENTS, "{}", signal(), MAX);
      const [sent] = transports.requests;
      expect(sent.headers).toEqual({
        authorization: "Bearer tok",
        "x-snowflake-authorization-token-type": tokenType,
        accept: "application/json",
        "user-agent": SNOWFLAKE_USER_AGENT,
      });
      expect(sent.body).toBe("{}");
      expect(sent.maxResponseBytes).toBe(MAX);
      expect(sent.headers["user-agent"].startsWith("LibreDB-Studio")).toBe(true);
    });
  }

  test("the text lane refuses link-local, upgrades and reports unreachable, with the TLS given", async () => {
    const { transports, transport } = setup();
    transports.answer({ path: /./ }, ok());
    await transport.status(STATUS, signal(), MAX);
    const [options] = transports.textOptions;
    expect(options.origin).toEqual(ORIGIN);
    expect(options.tls).toEqual(TLS);
    expect(options.maxSockets).toBe(8);
    expect(options.refusesLinkLocal).toBe(true);
    expect(options.refusesUpgrade).toBe(true);
    expect(options.reportsUnreachable).toBe(true);
  });

  test("the byte transport has the same origin and TLS, four sockets, and signs only authorization", async () => {
    const { transports, transport } = setup(scriptedTokens(["tok"], "PROGRAMMATIC_ACCESS_TOKEN"));
    transports.answer({ method: "GET", path: /./ }, bytesOk());
    await transport.partition(STATUS, "partition=1", signal(), 100, 90);
    const [options] = transports.byteOptions;
    expect(options.origin).toEqual(ORIGIN);
    expect(options.tls).toEqual(TLS);
    expect(options.maxSockets).toBe(4);
    expect(options.signer?.headerNames).toEqual(["authorization"]);
    expect(options.headers).toEqual({
      "x-snowflake-authorization-token-type": "PROGRAMMATIC_ACCESS_TOKEN",
      accept: "application/json",
      "user-agent": SNOWFLAKE_USER_AGENT,
    });
    expect(transports.requests[0].headers.authorization).toBe("Bearer tok");
  });

  test("a null TLS is passed as given, for a loopback origin", async () => {
    const { transports, transport } = setup(undefined, null);
    transports.answer({ path: /./ }, ok());
    await transport.status(STATUS, signal(), MAX);
    expect(transports.textOptions[0].tls).toBeNull();
    expect(transports.byteOptions[0].tls).toBeNull();
  });
});

describe("submit", () => {
  test("posts once to the statements path with async=true and a fresh requestId", async () => {
    const { transports, transport } = setup();
    transports.answer({ method: "POST", path: /./ }, { status: 202, text: '{"statementHandle":"x"}' });
    const answer = await transport.submit(STATEMENTS, '{"statement":"SELECT 1"}', signal(), MAX);
    expect(answer).toEqual({ status: 202, text: '{"statementHandle":"x"}', attempts: 1 });
    expect(transports.requests.map((request) => request.url)).toEqual([
      `https://${HOST}/api/v2/statements?async=true&requestId=${snowflakeTestUuid(1)}`,
    ]);
    expect(transports.requests[0].method).toBe("POST");
  });

  for (const status of [429, 500, 502, 503, 504]) {
    test(`a ${status} is resent with the same requestId and retry=true`, async () => {
      const { transports, clock, transport } = setup();
      transports.answer({ method: "POST", path: /./ }, { status }, ok({ code: "090001" }));
      const answer = await transport.submit(STATEMENTS, "{}", signal(), MAX);
      expect(answer.status).toBe(200);
      expect(answer.attempts).toBe(2);
      const id = snowflakeTestUuid(1);
      expect(transports.requests.map((request) => request.url)).toEqual([
        `https://${HOST}/api/v2/statements?async=true&requestId=${id}`,
        `https://${HOST}/api/v2/statements?async=true&requestId=${id}&retry=true`,
      ]);
      expect(transports.requests[1].body).toBe("{}");
      expect(clock.sleeps).toEqual([375]);
    });
  }

  for (const status of [400, 401, 403, 404, 408, 422, 522]) {
    test(`a ${status} is sent once`, async () => {
      const { transports, clock, transport } = setup();
      transports.answer({ method: "POST", path: /./ }, { status, text: "no" });
      const answer = await transport.submit(STATEMENTS, "{}", signal(), MAX);
      expect(answer).toEqual({ status, text: "no", attempts: 1 });
      expect(transports.requests).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
    });
  }

  test("five 503s give five sends, the doubling waits and attempts 5; each later send carries retry=true", async () => {
    const { transports, clock, transport } = setup();
    transports.answer({ method: "POST", path: /./ }, ...Array.from({ length: 6 }, () => ({ status: 503 })));
    const answer = await transport.submit(STATEMENTS, "{}", signal(), MAX);
    expect(answer.status).toBe(503);
    expect(answer.attempts).toBe(5);
    expect(transports.requests).toHaveLength(5);
    expect(clock.sleeps).toEqual([375, 750, 1500, 3000]);
    expect(transports.requests.slice(1).every((request) => request.url.endsWith("&retry=true"))).toBe(true);
    expect(new Set(transports.requests.map((request) => new URL(request.url).searchParams.get("requestId")))).toEqual(
      new Set([snowflakeTestUuid(1)]),
    );
  });

  test("two submits draw two requestIds", async () => {
    const { transports, transport } = setup();
    transports.answer({ method: "POST", path: /./ }, ok(), ok());
    await transport.submit(STATEMENTS, "{}", signal(), MAX);
    await transport.submit(STATEMENTS, "{}", signal(), MAX);
    expect(transports.requests.map((request) => new URL(request.url).searchParams.get("requestId"))).toEqual([
      snowflakeTestUuid(1),
      snowflakeTestUuid(2),
    ]);
  });

  test("an aborted signal sends nothing; an abort during the backoff rejects with its reason", async () => {
    const { transports, transport } = setup();
    transports.answer({ method: "POST", path: /./ }, ok());
    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.submit(STATEMENTS, "{}", aborted.signal, MAX)).rejects.toThrow(TransportError);
    expect(transports.requests).toHaveLength(0);

    const more = scriptedTransports();
    const clock = fakeClock();
    const deps = testDeps(more, clock);
    const controller = new AbortController();
    const reason = new Error("stopped by the user");
    const other = createSnowflakeTransport(
      { origin: ORIGIN, tls: TLS, tokens: scriptedTokens(["t1"]) },
      {
        ...deps,
        sleep: (ms, during) => {
          controller.abort(reason);
          return clock.sleep(ms, during);
        },
      },
    );
    more.answer({ method: "POST", path: /./ }, { status: 503 }, ok());
    await expect(other.submit(STATEMENTS, "{}", controller.signal, MAX)).rejects.toBe(reason);
    expect(more.requests).toHaveLength(1);
    expect(more.left()).toBe(1);
  });
});

describe("status", () => {
  for (const status of [202, 429]) {
    test(`a ${status} is returned after one send`, async () => {
      const { transports, clock, transport } = setup();
      transports.answer({ method: "GET", path: /./ }, { status, text: "running" });
      const answer = await transport.status(STATUS, signal(), 25_165_824);
      expect(answer).toEqual({ status, text: "running", attempts: 1 });
      expect(transports.requests.map((request) => request.url)).toEqual([`https://${HOST}${STATUS}`]);
      expect(transports.requests[0].maxResponseBytes).toBe(25_165_824);
      expect(clock.sleeps).toEqual([]);
    });
  }

  for (const status of [500, 502, 503, 504]) {
    test(`a ${status} is retried without retry=true`, async () => {
      const { transports, clock, transport } = setup();
      transports.answer({ method: "GET", path: /./ }, { status }, ok({ data: [] }));
      const answer = await transport.status(STATUS, signal(), MAX);
      expect(answer).toEqual({ status: 200, text: '{"data":[]}', attempts: 2 });
      expect(transports.requests.map((request) => request.url)).toEqual([
        `https://${HOST}${STATUS}`,
        `https://${HOST}${STATUS}`,
      ]);
      expect(clock.sleeps).toEqual([375]);
    });
  }

  for (const status of [400, 401, 403, 404, 408, 422, 522]) {
    test(`a ${status} is sent once`, async () => {
      const { transports, transport } = setup();
      transports.answer({ method: "GET", path: /./ }, { status });
      expect((await transport.status(STATUS, signal(), MAX)).attempts).toBe(1);
      expect(transports.requests).toHaveLength(1);
    });
  }

  test("five 500s give attempts 5", async () => {
    const { transports, transport } = setup();
    transports.answer({ method: "GET", path: /./ }, ...Array.from({ length: 6 }, () => ({ status: 500 })));
    const answer = await transport.status(STATUS, signal(), MAX);
    expect(answer.status).toBe(500);
    expect(answer.attempts).toBe(5);
    expect(transports.requests).toHaveLength(5);
  });
});

describe("partition", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    test(`a ${status} is retried`, async () => {
      const { transports, clock, transport } = setup();
      transports.answer({ method: "GET", path: /./ }, { status, bytes: Buffer.alloc(0) }, bytesOk('[["a"]]'));
      const answer = await transport.partition(STATUS, "partition=2", signal(), 1000, 900);
      expect(answer.status).toBe(200);
      expect(answer.bytes.toString()).toBe('[["a"]]');
      expect(answer.attempts).toBe(2);
      expect(answer.truncated).toBe(false);
      expect(answer.contentEncoding).toBeNull();
      expect(clock.sleeps).toEqual([375]);
      expect(transports.requests).toHaveLength(2);
    });
  }

  test("passes the path, query and both caps through, and reports the encoding and the cut", async () => {
    const { transports, transport } = setup();
    transports.answer(
      { method: "GET", path: /./ },
      { status: 200, bytes: Buffer.from("abcdef"), contentEncoding: "gzip" },
    );
    const answer = await transport.partition(STATUS, "partition=1", signal(), 10, 4);
    const [sent] = transports.requests;
    expect(sent.lane).toBe(-1);
    expect(sent.url).toBe(`https://${HOST}${STATUS}?partition=1`);
    expect(sent.maxResponseBytes).toBe(10);
    expect(sent.truncateAt).toBe(4);
    expect(answer).toEqual({
      status: 200,
      bytes: Buffer.from("abcd"),
      contentEncoding: "gzip",
      truncated: true,
      attempts: 1,
    });
  });

  test("a 404 is sent once, and five 503s give attempts 5", async () => {
    const { transports, transport } = setup();
    transports.answer({ method: "GET", path: /./ }, { status: 404, bytes: Buffer.alloc(0) });
    expect((await transport.partition(STATUS, "partition=1", signal(), 10, 10)).attempts).toBe(1);
    transports.answer(
      { method: "GET", path: /./ },
      ...Array.from({ length: 6 }, () => ({ status: 503, bytes: Buffer.alloc(0) })),
    );
    const answer = await transport.partition(STATUS, "partition=1", signal(), 10, 10);
    expect(answer.status).toBe(503);
    expect(answer.attempts).toBe(5);
    expect(transports.requests).toHaveLength(6);
  });

  test("the signer's bearer is the token current when each partition request is sent", async () => {
    const { transports, tokens, transport } = setup();
    transports.answer({ method: "GET", path: /./ }, bytesOk(), { status: 503, bytes: Buffer.alloc(0) }, bytesOk());
    await transport.partition(STATUS, "partition=1", signal(), 10, 10);
    tokens.advance();
    await transport.partition(STATUS, "partition=2", signal(), 10, 10);
    expect(transports.requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer t1",
      "Bearer t2",
      "Bearer t2",
    ]);
    expect(transport.recentTokens()).toEqual(["t1", "t2"]);
  });

  test("a programmatic access token of the longest length read reaches the wire on a partition read", async () => {
    // The byte transport holds a signer's values to 8192 bytes, so a bearer longer than 1024 bytes is sent whole.
    const listener = await rawHttpListener(() => rawAnswer("200 OK", ["content-length: 2"], "[]"));
    const pat = readAccessToken("A".repeat(SNOWFLAKE_TOKEN_MAX_CHARS));
    const transport = createSnowflakeTransport(
      { origin: httpOrigin("http", "127.0.0.1", listener.port), tls: null, tokens: patTokenSource(pat) },
      snowflakeProductionDeps(),
    );
    try {
      const answer = await transport.partition(STATUS, "partition=1", AbortSignal.timeout(5000), 100, 100);
      expect(answer.status).toBe(200);
      expect(listener.heads[0].toString("latin1").split("\r\n")).toContain(`authorization: Bearer ${pat}`);
    } finally {
      transport.close();
      await closeAll();
    }
  });
});

describe("cancel", () => {
  test("one POST with no body, never retried, even on 503", async () => {
    const { transports, clock, transport } = setup();
    transports.answer({ method: "POST", path: /\/cancel$/ }, { status: 503, text: "busy" }, ok());
    const answer = await transport.cancel(`${STATUS}/cancel`, signal(), MAX);
    expect(answer).toEqual({ status: 503, text: "busy", attempts: 1 });
    expect(transports.requests).toHaveLength(1);
    expect(transports.requests[0].url).toBe(`https://${HOST}${STATUS}/cancel`);
    expect(transports.requests[0].body).toBeUndefined();
    expect(clock.sleeps).toEqual([]);
  });
});

describe("lanes", () => {
  test("a renewal opens a new lane; the old one closes when its in-flight request ends", async () => {
    const { transports, tokens, transport } = setup(scriptedTokens(["t1", "t2"]));
    const first = deferredAnswer();
    transports.answer({ method: "GET", path: /./ }, first.answer, ok({ n: 2 }), ok({ n: 3 }));
    transports.answer({ method: "GET", path: /./ }, bytesOk());

    const inFlight = transport.status(STATUS, signal(), MAX);
    await transports.received(1);
    expect(transport.recentTokens()).toEqual(["t1"]);
    tokens.advance();

    const second = await transport.status(STATUS, signal(), MAX);
    expect(second.text).toBe('{"n":2}');
    expect(transports.requests.map((request) => [request.lane, request.headers.authorization])).toEqual([
      [0, "Bearer t1"],
      [1, "Bearer t2"],
    ]);
    expect(transports.closedLanes).toEqual([]);
    expect(transport.recentTokens()).toEqual(["t1", "t2"]);

    first.resolve(ok({ n: 1 }));
    expect((await inFlight).text).toBe('{"n":1}');
    expect(transports.closedLanes).toEqual([0]);

    await transport.status(STATUS, signal(), MAX);
    await transport.partition(STATUS, "partition=1", signal(), 10, 10);
    expect(transports.requests.map((request) => [request.lane, request.headers.authorization])).toEqual([
      [0, "Bearer t1"],
      [1, "Bearer t2"],
      [1, "Bearer t2"],
      [-1, "Bearer t2"],
    ]);
    expect(transports.lanesBuilt()).toBe(2);
    expect(transport.recentTokens()).toEqual(["t1", "t2"]);
  });

  test("an idle lane closes at once on renewal, and recentTokens keeps the last two", async () => {
    const { transports, tokens, transport } = setup();
    transports.answer({ path: /./ }, ok(), ok(), ok());
    await transport.status(STATUS, signal(), MAX);
    tokens.advance();
    await transport.status(STATUS, signal(), MAX);
    expect(transports.closedLanes).toEqual([0]);
    tokens.advance();
    await transport.status(STATUS, signal(), MAX);
    expect(transports.closedLanes).toEqual([0, 1]);
    expect(transport.recentTokens()).toEqual(["t2", "t3"]);
  });

  test("every resend of a submit takes the lane current when it is sent", async () => {
    const { transports, tokens, transport, deps } = setup();
    transports.answer({ method: "POST", path: /./ }, { status: 503 }, ok());
    const submit = transport.submit(STATEMENTS, "{}", signal(), MAX);
    await transports.received(1);
    tokens.advance();
    await submit;
    expect(transports.requests.map((request) => request.lane)).toEqual([0, 1]);
    expect(deps.deadlines.requested).toEqual([]);
  });

  test("a failed request still releases its lane", async () => {
    const { transports, tokens, transport } = setup();
    transports.answer({ path: /./ }, { fail: new TransportError("network", "reset") });
    await expect(transport.status(STATUS, signal(), MAX)).rejects.toThrow("reset");
    tokens.advance();
    transports.answer({ path: /./ }, ok());
    await transport.status(STATUS, signal(), MAX);
    expect(transports.closedLanes).toEqual([0]);
  });
});

describe("close", () => {
  test("closes every lane and the byte transport, and every later request rejects as closed", async () => {
    const { transports, tokens, transport } = setup();
    const held = deferredAnswer();
    transports.answer({ method: "GET", path: /./ }, held.answer, ok());
    transports.answer({ method: "GET", path: /./ }, bytesOk());
    const inFlight = transport.status(STATUS, signal(), MAX);
    await transports.received(1);
    tokens.advance();
    await transport.status(STATUS, signal(), MAX);
    await transport.partition(STATUS, "partition=1", signal(), 10, 10);

    transport.close();
    expect([...transports.closedLanes].sort()).toEqual([0, 1]);
    expect(transports.byteCloses()).toBe(1);
    await expect(inFlight).rejects.toThrow(TransportError);

    const closed = { name: "TransportError", kind: "aborted", message: "The Snowflake connection is closed" };
    await expect(transport.status(STATUS, signal(), MAX)).rejects.toMatchObject(closed);
    await expect(transport.submit(STATEMENTS, "{}", signal(), MAX)).rejects.toMatchObject(closed);
    await expect(transport.cancel(`${STATUS}/cancel`, signal(), MAX)).rejects.toMatchObject(closed);
    await expect(transport.partition(STATUS, "partition=1", signal(), 10, 10)).rejects.toMatchObject(closed);
    expect(transports.requests).toHaveLength(3);
  });

  test("a close that lands while a request awaits its token rejects it as closed and builds no lane", async () => {
    const { transports, tokens, transport } = setup();
    const release = tokens.hold();
    const status = transport.status(STATUS, signal(), MAX);
    const partition = transport.partition(STATUS, "partition=1", signal(), 10, 10);
    transport.close();
    release();
    const closed = { kind: "aborted", message: "The Snowflake connection is closed" };
    const [statusOutcome, partitionOutcome] = await Promise.allSettled([status, partition]);
    expect(statusOutcome).toMatchObject({ status: "rejected", reason: closed });
    expect(partitionOutcome).toMatchObject({ status: "rejected", reason: closed });
    expect(transports.lanesBuilt()).toBe(0);
    expect(transports.requests).toHaveLength(0);
    expect(tokens.calls()).toBe(2);
  });
});

describe("transport failures", () => {
  test("a redirect TransportError propagates as is and nothing further is sent", async () => {
    const redirect = new TransportError(
      "redirect",
      "The server answered with a redirect, which Studio does not follow",
    );
    const { transports, transport } = setup();
    transports.answer({ method: "POST", path: /./ }, { fail: redirect }, ok());
    await expect(transport.submit(STATEMENTS, "{}", signal(), MAX)).rejects.toBe(redirect);
    transports.answer({ method: "GET", path: /./ }, { fail: redirect }, bytesOk());
    await expect(transport.partition(STATUS, "partition=1", signal(), 10, 10)).rejects.toBe(redirect);
    expect(transports.requests).toHaveLength(2);
  });
});
