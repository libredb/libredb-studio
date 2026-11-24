/**
 * The Snowflake transport, statements and row reader on the production deps, against a local `node:http` server: what
 * reaches the wire, and what never does.
 *
 * The test builds the pieces directly, the composition the provider's `connect()` makes, with a loopback origin in
 * place of the one the Account field gives:
 *
 *   const origin = httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS);
 *   const egress = ALLOWS_PRIVATE_HOSTS;
 *   const transport = createSnowflakeTransport({ origin, tls: null, tokens: patTokenSource(PAT), egress }, snowflakeProductionDeps());
 *   const statements = createSnowflakeStatements({ transport, origin, context, queryTimeoutMs, failure, secrets, deps });
 *
 * So the deps seam is not injected: the shared node transports, the clock, `sleep`, `random`, `newId` and `deadline` are
 * the production ones, and these cases are what cover their closures. The host rule of `account.ts` is not on this
 * path, since the origin is built here, and no connection field or environment variable reaches it.
 *
 * The server answers in the shapes the trial capture recorded (tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/).
 * The resolver is stubbed for this file alone (the runner gives each file its own process): every name resolves to
 * the instance metadata address, so a name-based origin shows the link-local refusal before any byte is sent, while
 * the loopback listeners, dialled by IP literal, never reach a lookup.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const realDns = { ...(await import("node:dns")) };
const lookups: string[] = [];
const METADATA: LookupAddress = { address: "169.254.169.254", family: 4 };
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: LookupAddress[] | string,
  family?: number,
) => void;
const stubLookup = (hostname: string, options: unknown, callback?: LookupCallback) => {
  const done = (typeof options === "function" ? options : callback) as LookupCallback;
  lookups.push(hostname);
  const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
  if (all) done(null, [METADATA]);
  else done(null, METADATA.address, METADATA.family);
};
mock.module("node:dns", () => ({ ...realDns, lookup: stubLookup, default: { ...realDns, lookup: stubLookup } }));

const { LINK_LOCAL_HOST } = await import("@/lib/db/http/egress-policy");
const { httpOrigin } = await import("@/lib/db/http/endpoint");
const { patTokenSource } = await import("@/lib/db/providers/sql/snowflake/auth");
const { createSnowflakeStatements, SNOWFLAKE_QUERY_TAGS } = await import("@/lib/db/providers/sql/snowflake/statements");
const { createSnowflakeTransport, snowflakeProductionDeps, SNOWFLAKE_USER_AGENT } = await import(
  "@/lib/db/providers/sql/snowflake/transport"
);
const { closeAll, httpListener } = await import("../../../helpers/node-transport-fixtures");
type Listener = Awaited<ReturnType<typeof httpListener>>;
type Statements = ReturnType<typeof createSnowflakeStatements>;

const PAT = "stand-in-pat";
const HANDLE = "019c06a4-0000-df4f-0000-00100006589e";
const STATUS_PATH = `/api/v2/statements/${HANDLE}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const opened: Statements[] = [];

afterEach(async () => {
  for (const statements of opened.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- each closes its transport and releases its permits before the next.
    await statements.close();
  }
  await closeAll();
  lookups.length = 0;
});

/** The pieces `connect()` composes, on the production deps, aimed at `origin`. */
function wire(origin: ReturnType<typeof httpOrigin>, queryTimeoutMs = 60_000): Statements {
  const transport = createSnowflakeTransport(
    { origin, tls: null, tokens: patTokenSource(PAT), egress: ALLOWS_PRIVATE_HOSTS },
    snowflakeProductionDeps(),
  );
  const statements = createSnowflakeStatements({
    transport,
    origin,
    context: { role: "STUDIO_RO", warehouse: "STUDIO_WH" },
    queryTimeoutMs,
    failure: {
      host: origin.host,
      user: "studio_svc",
      role: "STUDIO_RO",
      authMethod: "pat",
      accountClaim: "TEST",
      userClaim: "STUDIO_SVC",
      fingerprint: null,
      fingerprintHex8: null,
      publicKeyBody: null,
    },
    secrets: () => [PAT],
    deps: snowflakeProductionDeps(),
  });
  opened.push(statements);
  return statements;
}

const toLoopback = (listener: Listener, queryTimeoutMs?: number): Statements =>
  wire(httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS), queryTimeoutMs);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const accepted = {
  code: "333334",
  message: "Asynchronous execution in progress. Use provided query id to perform query monitoring and management.",
  statementHandle: HANDLE,
  statementStatusUrl: STATUS_PATH,
};

function result(rows: string[][], partitions = 1): unknown {
  return {
    code: "090001",
    statementHandle: HANDLE,
    statementStatusUrl: STATUS_PATH,
    resultSetMetaData: {
      numRows: rows.length * partitions,
      format: "jsonv2",
      rowType: [{ name: "N", type: "fixed", precision: 38, scale: 0, length: null, nullable: true }],
      partitionInfo: Array.from({ length: partitions }, () => ({ rowCount: rows.length, uncompressedSize: 0 })),
    },
    data: rows,
  };
}

type Route = (request: IncomingMessage, response: ServerResponse, body: string) => void;

/** A server answering the submit, then each status GET, partition GET and cancel by the handlers given. */
function statementServer(routes: {
  readonly status?: Route;
  readonly partition?: Route;
  readonly cancel?: Route;
}): Route {
  return (request, response, body) => {
    const url = new URL(String(request.url), "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/v2/statements") json(response, 202, accepted);
    else if (request.method === "POST" && url.pathname.endsWith("/cancel"))
      (routes.cancel ?? ((_, r) => json(r, 200, { code: "000604", message: "SQL execution canceled" })))(
        request,
        response,
        body,
      );
    else if (url.searchParams.has("partition"))
      (routes.partition ?? ((_, r) => json(r, 404, {})))(request, response, body);
    else (routes.status ?? ((_, r) => json(r, 200, result([["1"]]))))(request, response, body);
  };
}

const paths = (listener: Listener): string[] =>
  listener.seen.map((seen) => `${seen.method} ${seen.url.replace(/requestId=[^&]+/, "requestId=<id>")}`);

describe("a statement over the wire", () => {
  test("a submit with async=true and a requestId, then a poll of the handle's status", async () => {
    const listener = await httpListener(statementServer({}));
    const outcome = await toLoopback(listener).runSurface("SHOW DATABASES LIMIT 1", SNOWFLAKE_QUERY_TAGS.connect);
    expect(outcome.rows).toEqual([{ N: 1 }]);
    expect(paths(listener)).toEqual(["POST /api/v2/statements?async=true&requestId=<id>", `GET ${STATUS_PATH}`]);
    const submit = new URL(listener.seen[0].url, "http://127.0.0.1");
    expect(submit.searchParams.get("requestId")).toMatch(UUID);
    expect(JSON.parse(listener.seen[0].body)).toEqual({
      statement: "SHOW DATABASES LIMIT 1",
      timeout: 30,
      warehouse: "STUDIO_WH",
      role: "STUDIO_RO",
      parameters: {
        multi_statement_count: "1",
        query_tag: SNOWFLAKE_QUERY_TAGS.connect,
        client_result_chunk_size: 16,
        rows_per_resultset: 100_001,
      },
    });
    expect(listener.seen[1].body).toBe("");
  });

  test("with the production deadline and the largest queryTimeout, an answer after 100 ms sends no cancel", async () => {
    const listener = await httpListener(
      statementServer({ status: (_request, response) => setTimeout(() => json(response, 200, result([["7"]])), 100) }),
    );
    const outcome = await toLoopback(listener, 2_147_483_647).runUser("SHOW TABLES", "q-long");
    expect(outcome.rows).toEqual([{ N: 7 }]);
    expect(JSON.parse(listener.seen[0].body).timeout).toBe(604_800);
    expect(listener.seen.some((seen) => seen.url.endsWith("/cancel"))).toBe(false);
  });

  test("partition 0 inline, then partitions 1 to 3 one at a time as gzip bytes, gunzipped", async () => {
    let inFlight = 0;
    let most = 0;
    const listener = await httpListener(
      statementServer({
        status: (_request, response) => json(response, 200, result([["0"]], 4)),
        partition: (request, response) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          const index = Number(new URL(String(request.url), "http://127.0.0.1").searchParams.get("partition"));
          setTimeout(() => {
            inFlight -= 1;
            response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
            response.end(gzipSync(JSON.stringify({ data: [[String(index * 10)], [String(index * 10 + 1)]] })));
          }, 10);
        },
      }),
    );
    const outcome = await toLoopback(listener).runUser("SHOW TABLES", undefined);
    expect(outcome.rows.map((row) => row.N)).toEqual([0, 10, 11, 20, 21, 30, 31]);
    expect(outcome.cut).toBe(false);
    expect(paths(listener).slice(2)).toEqual([1, 2, 3].map((index) => `GET ${STATUS_PATH}?partition=${index}`));
    expect(most).toBe(1);
    for (const seen of listener.seen) {
      expect(seen.headers.authorization).toBe(`Bearer ${PAT}`);
      expect(seen.headers["x-snowflake-authorization-token-type"]).toBe("PROGRAMMATIC_ACCESS_TOKEN");
      expect(seen.headers["user-agent"]).toBe(SNOWFLAKE_USER_AGENT);
    }
    for (const seen of listener.seen.slice(2)) expect(seen.headers["accept-encoding"]).toBe("identity");
  });

  test("a cancel by id goes out as one POST to the handle's cancel path while the poll waits", async () => {
    const parked: ServerResponse[] = [];
    const listener = await httpListener(statementServer({ status: (_request, response) => parked.push(response) }));
    const statements = toLoopback(listener);
    const run = statements.runUser("SHOW TABLES", "q-cancel").catch((error: unknown) => error);
    while (listener.seen.length < 2) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the poll to reach the server.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await statements.cancel("q-cancel")).toBe(true);
    expect(((await run) as Error).message).toBe("The query was cancelled.");
    expect(paths(listener).filter((path) => path.endsWith("/cancel"))).toEqual([`POST ${STATUS_PATH}/cancel`]);
    for (const response of parked) response.destroy();
  });

  test("a 302 on the status GET sends nothing further, there or anywhere", async () => {
    const elsewhere = await httpListener((_request, response) => json(response, 200, result([["1"]])));
    const listener = await httpListener(
      statementServer({
        status: (_request, response) => {
          response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}${STATUS_PATH}` });
          response.end();
        },
      }),
    );
    const error = await toLoopback(listener)
      .runSurface("SHOW DATABASES LIMIT 1", SNOWFLAKE_QUERY_TAGS.connect)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(paths(listener)).toEqual(["POST /api/v2/statements?async=true&requestId=<id>", `GET ${STATUS_PATH}`]);
    expect(elsewhere.accepted()).toBe(0);
  });
});

describe("a name that resolves to the instance metadata address", () => {
  const origin = (): ReturnType<typeof httpOrigin> =>
    httpOrigin("http", "metadata.snowflake.test", 80, ALLOWS_PRIVATE_HOSTS);

  test("is refused on a status GET before any byte is sent", async () => {
    const transport = createSnowflakeTransport(
      { origin: origin(), tls: null, tokens: patTokenSource(PAT), egress: ALLOWS_PRIVATE_HOSTS },
      snowflakeProductionDeps(),
    );
    try {
      const error = await transport.status(STATUS_PATH, AbortSignal.timeout(5_000), 1024).catch((e: unknown) => e);
      expect((error as Error).message).toContain(LINK_LOCAL_HOST);
      expect(lookups).toContain("metadata.snowflake.test");
    } finally {
      transport.close();
    }
  });

  test("is refused on a partition GET before any byte is sent", async () => {
    const transport = createSnowflakeTransport(
      { origin: origin(), tls: null, tokens: patTokenSource(PAT), egress: ALLOWS_PRIVATE_HOSTS },
      snowflakeProductionDeps(),
    );
    try {
      const error = await transport
        .partition(STATUS_PATH, "partition=1", AbortSignal.timeout(5_000), 1024, 1024)
        .catch((e: unknown) => e);
      expect((error as Error).message).toContain(LINK_LOCAL_HOST);
      expect(lookups).toContain("metadata.snowflake.test");
    } finally {
      transport.close();
    }
  });
});

describe("the production sleep", () => {
  const { sleep } = snowflakeProductionDeps();

  test("waits its time, then resolves", async () => {
    const started = performance.now();
    await sleep(20, new AbortController().signal);
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("rejects with the reason of a signal that had already aborted, without waiting", async () => {
    const reason = new Error("stopped before");
    await expect(sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason);
  });

  test("rejects with the reason when the signal aborts during the wait", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped during");
    const waiting = sleep(60_000, controller.signal);
    setTimeout(() => controller.abort(reason), 5);
    await expect(waiting).rejects.toBe(reason);
  });
});
