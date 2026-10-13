/**
 * The Snowflake provider class over scripted transports: `connect()`'s order and its two statements, the cautions,
 * the run-in-flight answer on every exit, `disconnect()`'s cancels, the result mapping and every declaration of the
 * features it leaves off. No socket and no real timer: the transports are the scripted ones and every deadline is a
 * test deadline, fired by the test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { KeyObject } from "node:crypto";
import { enumerateContainers, scopeGroundingContainers } from "@/lib/db/container-walk";
import { AuthenticationError, DatabaseConfigError, QueryCancelledError, QueryError } from "@/lib/db/errors";
import { SNOWFLAKE_FIELD_SENTENCES } from "@/lib/db/providers/sql/snowflake/account-host";
import { SNOWFLAKE, SNOWFLAKE_ERROR_SENTENCES } from "@/lib/db/providers/sql/snowflake/errors";
import {
  SNOWFLAKE_OBJECT_KINDS,
  SNOWFLAKE_PROVIDER_SENTENCES,
  SnowflakeProvider,
} from "@/lib/db/providers/sql/snowflake/index";
import { SNOWFLAKE_INTROSPECT_SENTENCES } from "@/lib/db/providers/sql/snowflake/introspect";
import { SNOWFLAKE_MONITORING_LABELS } from "@/lib/db/providers/sql/snowflake/monitoring";
import { SNOWFLAKE_ROWS_SENTENCES } from "@/lib/db/providers/sql/snowflake/rows";
import {
  SNOWFLAKE_QUERY_TAGS,
  SNOWFLAKE_ROLE_CHECK_SQL,
  SNOWFLAKE_STATEMENT_SENTENCES,
} from "@/lib/db/providers/sql/snowflake/statements";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { failureAnswer, handleAnswer, resultAnswer } from "../../../helpers/snowflake-answers";
import { KEY_TEST_PASSPHRASE, pbes2Pbkdf2Pem, pkcs8Pem, rsaKey } from "../../../helpers/snowflake-keys";
import {
  deferredAnswer,
  fakeClock,
  type RecordedRequest,
  type ScriptedAnswer,
  scriptedTransports,
  testDeps,
} from "../../../helpers/snowflake-node-transport";
import { CANCEL, roleAnswer, STATUS, SUBMIT, tick } from "../../../helpers/snowflake-statements";

const KEY = rsaKey();
const PEM = pkcs8Pem(KEY);
const HOST = "myorg-myacct.snowflakecomputing.com";
const HANG: ScriptedAnswer = { hang: true };
const CONFIRMED: ScriptedAnswer = { status: 200, json: { code: "000604", message: "SQL execution canceled" } };
const WAREHOUSE_COLUMNS = ["name", "state", "size", "auto_resume"].map((name) => ({ name, type: "text" }));

const warehouses = (...rows: (string | null)[][]): ScriptedAnswer => resultAnswer({ columns: WAREHOUSE_COLUMNS, rows });
const RUNNING = warehouses(["STUDIO_WH", "STARTED", "X-Small", "true"]);
/** The role check answered with the configured role and no secondary roles. */
const ROLE_OK = roleAnswer("STUDIO_RO");

function connection(overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "sf",
    name: "Snowflake",
    type: SNOWFLAKE,
    host: "myorg-myacct",
    user: "studio_svc",
    role: "STUDIO_RO",
    warehouse: "STUDIO_WH",
    authMethod: "keypair",
    privateKey: PEM,
    createdAt: new Date(0),
    ...overrides,
  } as DatabaseConnection;
}

interface Built {
  readonly provider: SnowflakeProvider;
  readonly transports: ReturnType<typeof scriptedTransports>;
  readonly deps: ReturnType<typeof testDeps>;
  readonly clock: ReturnType<typeof fakeClock>;
}

const built: Built[] = [];

function build(overrides: Record<string, unknown> = {}): Built {
  const transports = scriptedTransports();
  const clock = fakeClock();
  const deps = testDeps(transports, clock);
  const provider = new SnowflakeProvider(connection(overrides), {}, deps);
  const entry = { provider, transports, deps, clock };
  built.push(entry);
  return entry;
}

/**
 * A provider connected over the connect answer given (a running warehouse by default) and the role check's answer
 * (the configured role by default), its requests cleared.
 */
async function connected(
  overrides: Record<string, unknown> = {},
  answer: ScriptedAnswer = RUNNING,
  check: ScriptedAnswer = ROLE_OK,
): Promise<Built> {
  const entry = build(overrides);
  entry.transports.answer(SUBMIT, answer, check);
  await entry.provider.connect();
  entry.transports.requests.splice(0);
  return entry;
}

/** Fires every deadline asked for, again and again, until `promise` settles. */
async function settle(entry: Built, promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const done = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 50; round += 1) {
    if (settled) break;
    entry.deps.deadlines.requested.forEach((_, index) => entry.deps.deadlines.fire(index));
    // oxlint-disable-next-line no-await-in-loop -- each round lets the runs react before the next fire.
    await tick();
  }
  await done;
}

let warn: ReturnType<typeof spyOn>;
beforeAll(() => {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterAll(() => warn.mockRestore());
afterEach(async () => {
  // The engine limiter is process-wide: every provider ends its runs before the next test.
  for (const entry of built.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- each provider releases its permits before the next.
    await settle(entry, entry.provider.disconnect());
  }
  warn.mockClear();
});

const bodyOf = (request: RecordedRequest): Record<string, unknown> => JSON.parse(request.body ?? "{}");
const submits = (entry: Built): RecordedRequest[] =>
  entry.transports.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/api/v2/statements");
const cancels = (entry: Built): RecordedRequest[] => entry.transports.requests.filter((r) => r.url.endsWith("/cancel"));

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** The outcome of a call that is left running, so the test can act while it is in flight. */
function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => error,
  );
}

let handles = 0;
const nextHandle = (): string => `019c06a4-0000-df4f-0000-${String((handles += 1)).padStart(12, "0")}`;

describe("connect() validates the configuration before any socket", () => {
  const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["an empty account", { host: "" }, SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
    ["no account", { host: undefined }, SNOWFLAKE_FIELD_SENTENCES.accountEmpty],
    [
      "a refused account form",
      { host: "jdbc:snowflake://myorg-myacct.snowflakecomputing.com" },
      SNOWFLAKE_FIELD_SENTENCES.accountFormat,
    ],
    ["an empty user", { user: "  " }, SNOWFLAKE_FIELD_SENTENCES.userEmpty],
    ["an unknown sign-in method", { authMethod: "password" }, SNOWFLAKE_FIELD_SENTENCES.method],
    ["no key under keypair", { privateKey: "" }, SNOWFLAKE_FIELD_SENTENCES.keyEmpty],
    ["no token under pat", { authMethod: "pat", password: "" }, SNOWFLAKE_FIELD_SENTENCES.tokenEmpty],
    ["an empty role", { role: "" }, SNOWFLAKE_FIELD_SENTENCES.roleEmpty],
    ["no role", { role: undefined }, SNOWFLAKE_FIELD_SENTENCES.roleEmpty],
  ];
  for (const [label, overrides, sentence] of cases) {
    test(`${label} is refused with its sentence, nothing sent and no lane built`, async () => {
      const entry = build(overrides);
      const error = await caught(entry.provider.connect());
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as Error).message).toBe(sentence);
      expect(entry.transports.requests).toHaveLength(0);
      expect(entry.transports.lanesBuilt()).toBe(0);
      expect(entry.provider.isConnected()).toBe(false);
      expect(entry.provider.hasRunsInFlight()).toBe(false);
    });
  }

  test("the user is checked before the method, and the method before the role", async () => {
    const entry = build({ user: "", authMethod: "nope", role: "" });
    expect(((await caught(entry.provider.connect())) as Error).message).toBe(SNOWFLAKE_FIELD_SENTENCES.userEmpty);
    const second = build({ authMethod: "nope", role: "" });
    expect(((await caught(second.provider.connect())) as Error).message).toBe(SNOWFLAKE_FIELD_SENTENCES.method);
  });

  test("an unreadable key is refused before any socket", async () => {
    const entry = build({ privateKey: "not a key" });
    expect(await caught(entry.provider.connect())).toBeInstanceOf(DatabaseConfigError);
    expect(entry.transports.requests).toHaveLength(0);
  });
});

describe("connect() sends the connect statement, then the role check", () => {
  test("a configured Warehouse is read by name, tagged connect, under the surface timeout", async () => {
    const entry = build();
    entry.transports.answer(SUBMIT, RUNNING, ROLE_OK);
    await entry.provider.connect();
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.transports.requests).toHaveLength(2);
    const body = bodyOf(entry.transports.requests[0]);
    expect(body.statement).toBe("SHOW WAREHOUSES LIKE 'STUDIO_WH'");
    expect(body.timeout).toBe(30);
    expect(body.role).toBe("STUDIO_RO");
    expect(body.warehouse).toBe("STUDIO_WH");
    expect((body.parameters as Record<string, unknown>).query_tag).toBe(SNOWFLAKE_QUERY_TAGS.connect);
    expect(new URL(entry.transports.requests[0].url).host).toBe(HOST);
    expect(entry.transports.textOptions[0].tls).toEqual({ rejectUnauthorized: true, identity: HOST });
    expect(entry.transports.requests[0].headers["x-snowflake-authorization-token-type"]).toBe("KEYPAIR_JWT");
    // The connect statement's own deadline, the surface timeout plus the grace.
    expect(entry.deps.deadlines.requested).toContain(35_000);
    const check = bodyOf(entry.transports.requests[1]);
    expect(check.statement).toBe(SNOWFLAKE_ROLE_CHECK_SQL);
    expect(check.timeout).toBe(30);
    expect(check.role).toBe("STUDIO_RO");
    expect(check.warehouse).toBe("STUDIO_WH");
    expect((check.parameters as Record<string, unknown>).query_tag).toBe(SNOWFLAKE_QUERY_TAGS.roleCheck);
  });

  test("a quote and a backslash in Warehouse are escaped", async () => {
    const entry = build({ warehouse: "a'b\\c" });
    entry.transports.answer(SUBMIT, warehouses(), ROLE_OK);
    await entry.provider.connect();
    expect(bodyOf(entry.transports.requests[0]).statement).toBe("SHOW WAREHOUSES LIKE 'a''b\\\\c'");
  });

  test("an empty Warehouse sends SHOW DATABASES LIMIT 1, then the check, neither with a warehouse field", async () => {
    const entry = build({ warehouse: "" });
    entry.transports.answer(
      SUBMIT,
      resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["SALES"]] }),
      ROLE_OK,
    );
    await entry.provider.connect();
    expect(entry.provider.isConnected()).toBe(true);
    const bodies = entry.transports.requests.map(bodyOf);
    expect(bodies.map((body) => body.statement)).toEqual(["SHOW DATABASES LIMIT 1", SNOWFLAKE_ROLE_CHECK_SQL]);
    for (const body of bodies) expect(body).not.toHaveProperty("warehouse");
  });

  test("another role answered fails connect() with AuthenticationError, closes the session and connects nothing", async () => {
    const entry = build({ role: "studio_ro" });
    entry.transports.answer(SUBMIT, RUNNING, roleAnswer("STUDIO_RW"));
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("STUDIO_RW", "studio_ro"));
    expect(entry.provider.isConnected()).toBe(false);
    expect(entry.transports.closedLanes).toContain(0);
    expect(entry.provider.connectWarnings()).toEqual([]);
  });

  test("a disconnect() while the role check runs ends connect() cancelled", async () => {
    const entry = build();
    const check = deferredAnswer();
    entry.transports.answer(SUBMIT, RUNNING, check.answer);
    const outcome = outcomeOf(entry.provider.connect());
    await entry.transports.received(2);
    const disconnecting = entry.provider.disconnect();
    check.resolve(ROLE_OK);
    await disconnecting;
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("a connect() displaced by a second one on the same instance closes its session, and the second connects", async () => {
    const entry = build();
    const first = deferredAnswer();
    entry.transports.answer(SUBMIT, first.answer, RUNNING, ROLE_OK, ROLE_OK);
    const outcome = outcomeOf(entry.provider.connect());
    await entry.transports.received(1);
    await entry.provider.connect();
    expect(entry.transports.lanesBuilt()).toBe(2);
    first.resolve(RUNNING);
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(entry.transports.closedLanes).toEqual([0]);
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });

  test("a programmatic access token is its own bearer", async () => {
    const entry = build({ authMethod: "pat", password: "pat-value", privateKey: undefined });
    entry.transports.answer(SUBMIT, RUNNING, ROLE_OK);
    await entry.provider.connect();
    const [request] = entry.transports.requests;
    expect(request.headers["x-snowflake-authorization-token-type"]).toBe("PROGRAMMATIC_ACCESS_TOKEN");
    expect(request.headers.authorization).toBe("Bearer pat-value");
  });

  test("a refused key pair maps to AuthenticationError with the statement that registers the key", async () => {
    const entry = build();
    entry.transports.answer(
      SUBMIT,
      failureAnswer(401, "390144", "JWT token is invalid. [0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b]"),
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).fixStatement).toStartWith("ALTER USER <name> ADD KEY PAIR libredb_studio_");
    expect(entry.provider.isConnected()).toBe(false);
    expect(entry.transports.closedLanes).toContain(0);
  });

  test("a second connect() replaces the first session and closes it", async () => {
    const entry = await connected();
    entry.transports.answer(SUBMIT, RUNNING, ROLE_OK);
    await entry.provider.connect();
    expect(entry.transports.closedLanes).toContain(0);
    expect(entry.transports.byteCloses()).toBe(1);
    expect(entry.provider.isConnected()).toBe(true);
  });
});

describe("the connect cautions", () => {
  test("an answer holding A_B and AXB for A_B reads A_B only", async () => {
    const entry = await connected(
      { warehouse: "A_B" },
      warehouses(["AXB", "SUSPENDED", "X-Small", "false"], ["A_B", "STARTED", "X-Small", "true"]),
    );
    expect(entry.provider.connectWarnings()).toEqual([]);
  });

  test("an answer holding only AXB is no row", async () => {
    const entry = await connected({ warehouse: "A_B" }, warehouses(["AXB", "STARTED", "X-Small", "true"]));
    expect(entry.provider.connectWarnings()).toEqual([
      { message: SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow("A_B", "STUDIO_RO") },
    ]);
    expect(entry.provider.connectWarnings()[0].message).toBe(
      "Snowflake shows no warehouse named A_B to role STUDIO_RO. Check the name, and that the role has USAGE on it.",
    );
  });

  test("a suspended warehouse that does not resume", async () => {
    const entry = await connected({}, warehouses(["STUDIO_WH", "SUSPENDED", "X-Small", "false"]));
    expect(entry.provider.connectWarnings().map((w) => w.message)).toEqual([
      "Warehouse STUDIO_WH is suspended and does not resume on its own, so queries fail until someone resumes it.",
    ]);
  });

  test("an empty Warehouse", async () => {
    const entry = await connected(
      { warehouse: "" },
      resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [] }),
    );
    expect(entry.provider.connectWarnings().map((w) => w.message)).toEqual([
      "Warehouse is empty, so queries use the user's default warehouse and fail if the user has none. Browsing works without one.",
    ]);
  });

  test("active secondary roles add their caution after the warehouse's", async () => {
    const entry = await connected(
      {},
      warehouses(["STUDIO_WH", "SUSPENDED", "X-Small", "false"]),
      roleAnswer("STUDIO_RO", '{"roles":"ANALYST,LOADER","value":""}'),
    );
    expect(entry.provider.connectWarnings().map((w) => w.message)).toEqual([
      SNOWFLAKE_INTROSPECT_SENTENCES.notResuming("STUDIO_WH"),
      SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("ANALYST,LOADER", "STUDIO_RO"),
    ]);
  });

  test("none for a running warehouse, and none after disconnect()", async () => {
    const entry = await connected();
    expect(entry.provider.connectWarnings()).toEqual([]);
    await entry.provider.disconnect();
    expect(entry.provider.connectWarnings()).toEqual([]);
  });
});

describe("getHealth()", () => {
  test("sends one statement, tagged health", async () => {
    const entry = await connected();
    entry.transports.answer(SUBMIT, RUNNING);
    const health = await entry.provider.getHealth();
    expect(entry.transports.requests).toHaveLength(1);
    const body = bodyOf(entry.transports.requests[0]);
    expect(body.statement).toBe("SHOW WAREHOUSES LIKE 'STUDIO_WH'");
    expect((body.parameters as Record<string, unknown>).query_tag).toBe(SNOWFLAKE_QUERY_TAGS.health);
    expect(health).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
  });

  test("refuses on an unconnected provider", async () => {
    const entry = build();
    expect(await caught(entry.provider.getHealth())).toBeInstanceOf(DatabaseConfigError);
  });
});

describe("the provider keeps no copy of the key or the passphrase", () => {
  /** Every string reachable from `value` through own properties, skipping KeyObjects. */
  function strings(value: unknown, seen: Set<unknown> = new Set()): string[] {
    if (typeof value === "string") return [value];
    if (typeof value !== "object" || value === null || value instanceof KeyObject || seen.has(value)) return [];
    seen.add(value);
    const children: unknown[] =
      value instanceof Map ? [...value.keys(), ...value.values()] : value instanceof Set ? [...value] : [];
    for (const name of Object.getOwnPropertyNames(value)) {
      children.push((value as Record<string, unknown>)[name]);
    }
    return children.flatMap((child) => strings(child, seen));
  }

  test("after connect(), no field but config holds the PEM body or the passphrase", async () => {
    const pem = pbes2Pbkdf2Pem(KEY, KEY_TEST_PASSPHRASE, 2_048);
    const entry = await connected({ privateKey: pem, privateKeyPassphrase: KEY_TEST_PASSPHRASE });
    const lines = pem.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
    const body = lines.join("");
    const found = Object.getOwnPropertyNames(entry.provider)
      .filter((name) => name !== "config")
      .flatMap((name) => strings((entry.provider as unknown as Record<string, unknown>)[name]));
    expect(found.length).toBeGreaterThan(0);
    for (const text of found) {
      expect(text.includes(body)).toBe(false);
      expect(text.includes(lines[0])).toBe(false);
      expect(text.includes(KEY_TEST_PASSPHRASE)).toBe(false);
    }
    expect(entry.provider.config.privateKey).toBe(pem);
    expect(entry.provider.config.privateKeyPassphrase).toBe(KEY_TEST_PASSPHRASE);
  });
});

describe("hasRunsInFlight() on every exit", () => {
  test("false on an unconnected provider and after a failed connect(), never throwing", async () => {
    const entry = build();
    expect(entry.provider.hasRunsInFlight()).toBe(false);
    entry.transports.answer(SUBMIT, failureAnswer(403, "390001", "forbidden"));
    expect(await caught(entry.provider.connect())).toBeInstanceOf(AuthenticationError);
    expect(() => entry.provider.hasRunsInFlight()).not.toThrow();
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });

  for (const queryId of ["q-1", undefined]) {
    const label = queryId === undefined ? "without a queryId" : "with a queryId";
    const run = (entry: Built) => outcomeOf(entry.provider.query("SHOW TABLES", [], queryId));

    test(`success, ${label}`, async () => {
      const entry = await connected();
      const status = deferredAnswer();
      entry.transports.answer(SUBMIT, handleAnswer());
      entry.transports.answer(STATUS, status.answer);
      const outcome = run(entry);
      await entry.transports.received(2);
      expect(entry.provider.hasRunsInFlight()).toBe(true);
      status.resolve(resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["T"]] }));
      expect(await outcome).toMatchObject({ rows: [{ name: "T" }] });
      expect(entry.provider.hasRunsInFlight()).toBe(false);
    });

    test(`a failed statement, ${label}`, async () => {
      const entry = await connected();
      const status = deferredAnswer();
      entry.transports.answer(SUBMIT, handleAnswer());
      entry.transports.answer(STATUS, status.answer);
      const outcome = run(entry);
      await entry.transports.received(2);
      expect(entry.provider.hasRunsInFlight()).toBe(true);
      status.resolve(failureAnswer(422, "000904", "invalid identifier"));
      expect(await outcome).toBeInstanceOf(QueryError);
      expect(entry.provider.hasRunsInFlight()).toBe(false);
    });

    test(`the deadline, ${label}`, async () => {
      const entry = await connected();
      entry.transports.answer(SUBMIT, handleAnswer());
      entry.transports.answer(STATUS, HANG);
      entry.transports.answer(CANCEL, CONFIRMED);
      const outcome = run(entry);
      await entry.transports.received(2);
      expect(entry.provider.hasRunsInFlight()).toBe(true);
      entry.deps.deadlines.fire(entry.deps.deadlines.requested.lastIndexOf(65_000));
      const error = await outcome;
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toContain("within the connection's query timeout of 60 s");
      expect(cancels(entry)).toHaveLength(1);
      expect(entry.provider.hasRunsInFlight()).toBe(false);
    });

    test(`disconnect() during the poll, ${label}`, async () => {
      const entry = await connected();
      entry.transports.answer(SUBMIT, handleAnswer());
      entry.transports.answer(STATUS, HANG);
      entry.transports.answer(CANCEL, CONFIRMED);
      const outcome = run(entry);
      await entry.transports.received(2);
      expect(entry.provider.hasRunsInFlight()).toBe(true);
      await entry.provider.disconnect();
      expect(await outcome).toBeInstanceOf(QueryCancelledError);
      expect(cancels(entry)).toHaveLength(1);
      expect(entry.provider.hasRunsInFlight()).toBe(false);
    });
  }

  test("a user cancel", async () => {
    const entry = await connected();
    entry.transports.answer(SUBMIT, handleAnswer());
    entry.transports.answer(STATUS, HANG);
    entry.transports.answer(CANCEL, CONFIRMED);
    const outcome = outcomeOf(entry.provider.query("SHOW TABLES", [], "q-1"));
    await entry.transports.received(2);
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    expect(await entry.provider.cancelQuery("q-1")).toBe(true);
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });

  test("an abort during the submit, with a queryId: its cancel follows the submit's answer", async () => {
    const entry = await connected();
    const submit = deferredAnswer();
    entry.transports.answer(SUBMIT, submit.answer);
    entry.transports.answer(CANCEL, CONFIRMED);
    const outcome = outcomeOf(entry.provider.query("SHOW TABLES", [], "q-1"));
    await entry.transports.received(1);
    const cancelling = entry.provider.cancelQuery("q-1");
    await tick();
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    submit.resolve(handleAnswer());
    expect(await cancelling).toBe(true);
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(cancels(entry)).toHaveLength(1);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });

  test("an abort during the submit, without one: a submit answered after disconnect() began sends one cancel", async () => {
    const entry = await connected();
    const submit = deferredAnswer();
    entry.transports.answer(SUBMIT, submit.answer);
    entry.transports.answer(CANCEL, CONFIRMED);
    const outcome = outcomeOf(entry.provider.query("SHOW TABLES"));
    await entry.transports.received(1);
    const disconnecting = entry.provider.disconnect();
    await tick();
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    submit.resolve(handleAnswer());
    await disconnecting;
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(cancels(entry)).toHaveLength(1);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });

  test("a pending monitoring read counts until it ends, and disconnect() during it sends one cancel", async () => {
    const entry = await connected();
    entry.transports.answer(SUBMIT, RUNNING, handleAnswer());
    entry.transports.answer(STATUS, HANG);
    entry.transports.answer(CANCEL, CONFIRMED);
    const outcome = outcomeOf(entry.provider.getSlowQueries());
    await entry.transports.received(3);
    expect(bodyOf(submits(entry)[1]).statement).toContain("INFORMATION_SCHEMA");
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    await entry.provider.disconnect();
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(cancels(entry)).toHaveLength(1);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });

  test("connect()'s own statement counts, and disconnect() during its poll cancels it", async () => {
    const entry = build();
    entry.transports.answer(SUBMIT, handleAnswer());
    entry.transports.answer(STATUS, HANG);
    entry.transports.answer(CANCEL, CONFIRMED);
    const outcome = outcomeOf(entry.provider.connect());
    await entry.transports.received(2);
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    await entry.provider.disconnect();
    expect(await outcome).toBeInstanceOf(QueryCancelledError);
    expect(cancels(entry)).toHaveLength(1);
    expect(entry.provider.isConnected()).toBe(false);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });
});

describe("disconnect()", () => {
  test("two runs in flight get two cancels, sent in parallel, each under its own 5 s", async () => {
    const entry = await connected();
    entry.transports.answer(SUBMIT, handleAnswer(nextHandle()), handleAnswer(nextHandle()));
    entry.transports.answer(STATUS, HANG, HANG);
    const answers = [deferredAnswer(), deferredAnswer()];
    entry.transports.answer(CANCEL, ...answers.map((answer) => answer.answer));
    const outcomes = [
      outcomeOf(entry.provider.query("SHOW TABLES", [], "q-1")),
      outcomeOf(entry.provider.query("SHOW VIEWS")),
    ];
    await entry.transports.received(4);
    const before = entry.deps.deadlines.requested.length;
    const disconnecting = entry.provider.disconnect();
    await entry.transports.received(6);
    expect(cancels(entry)).toHaveLength(2);
    expect(entry.deps.deadlines.requested.slice(before)).toEqual([5_000, 5_000]);
    for (const answer of answers) answer.resolve(CONFIRMED);
    await disconnecting;
    for (const outcome of outcomes) {
      // oxlint-disable-next-line no-await-in-loop -- both runs have ended; each outcome is read in turn.
      expect(await outcome).toBeInstanceOf(QueryCancelledError);
    }
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("eight runs with hanging cancels end disconnect() once their deadlines fire", async () => {
    const entry = await connected();
    // Four runs hold the provider's four permits and have handles; four more wait for a permit and have none.
    entry.transports.answer(SUBMIT, ...Array.from({ length: 4 }, () => handleAnswer(nextHandle())));
    entry.transports.answer(STATUS, HANG, HANG, HANG, HANG);
    entry.transports.answer(CANCEL, HANG, HANG, HANG, HANG);
    const outcomes = [
      outcomeOf(entry.provider.query("SHOW TABLES", [], "q-1")),
      outcomeOf(entry.provider.query("SHOW TABLES")),
      outcomeOf(entry.provider.listContainers()),
      outcomeOf(entry.provider.query("SHOW TABLES", [], "q-2")),
      outcomeOf(entry.provider.query("SHOW TABLES", [], "q-3")),
      outcomeOf(entry.provider.query("SHOW TABLES")),
      outcomeOf(entry.provider.listContainers(["SALES"])),
      outcomeOf(entry.provider.query("SHOW TABLES", [], "q-4")),
    ];
    await entry.transports.received(8);
    await tick();
    expect(submits(entry)).toHaveLength(4);
    const before = entry.deps.deadlines.requested.length;
    let ended = false;
    const disconnecting = entry.provider.disconnect().then(() => {
      ended = true;
    });
    await entry.transports.received(12);
    await tick();
    expect(ended).toBe(false);
    for (let index = before; index < entry.deps.deadlines.requested.length; index += 1) {
      entry.deps.deadlines.fire(index);
    }
    await disconnecting;
    expect(cancels(entry)).toHaveLength(4);
    for (const outcome of outcomes) {
      // oxlint-disable-next-line no-await-in-loop -- every run has ended; each outcome is read in turn.
      expect(await outcome).toBeInstanceOf(QueryCancelledError);
    }
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });
});

describe("query()", () => {
  test("bound parameters are refused and nothing is sent", async () => {
    const entry = await connected();
    const error = await caught(entry.provider.query("SELECT ?", [1]));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(SNOWFLAKE_PROVIDER_SENTENCES.params);
    expect((error as Error).message).toBe(
      "Snowflake's SQL API takes no bound parameters from Studio; write the value in the statement.",
    );
    expect(entry.transports.requests).toHaveLength(0);
  });

  test("a result maps to the grid's shape, the statement sent alone", async () => {
    const entry = await connected();
    entry.transports.answer(
      SUBMIT,
      resultAnswer({ columns: [{ name: "N", type: "fixed", precision: 38, scale: 0 }], rows: [["1"], ["2"]] }),
    );
    const result = await entry.provider.query("SELECT 1");
    expect(submits(entry).map((r) => bodyOf(r).statement)).toEqual(["SELECT 1"]);
    expect(result.fields).toEqual(["N"]);
    expect(result.rows).toEqual([{ N: 1 }, { N: 2 }]);
    expect(result.rowCount).toBe(2);
    expect(result.columnTypes).toEqual({ N: "NUMBER(38,0)" });
    expect(result).not.toHaveProperty("warnings");
    expect(result).not.toHaveProperty("pagination");
    expect(typeof result.executionTime).toBe("number");
  });

  test("a cut result carries wasLimited without hasMore, and the cut warning", async () => {
    const entry = await connected();
    entry.transports.answer(
      SUBMIT,
      resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["T"]], code: "391908" }),
    );
    const result = await entry.provider.query("SHOW TABLES");
    expect(result.pagination).toEqual({
      limit: MAX_UNLIMITED_ROWS,
      offset: 0,
      hasMore: false,
      totalReturned: 1,
      wasLimited: true,
    });
    expect(result.warnings?.map((w) => w.message)).toContain(SNOWFLAKE_ROWS_SENTENCES.snowflakeCut);
  });

  test("an unconnected provider refuses", async () => {
    const entry = build();
    expect(await caught(entry.provider.query("SELECT 1"))).toBeInstanceOf(DatabaseConfigError);
  });

  test("cancelQuery of an unknown id, or on an unconnected provider, answers false and sends nothing", async () => {
    expect(await build().provider.cancelQuery("q-9")).toBe(false);
    const entry = await connected();
    expect(await entry.provider.cancelQuery("q-9")).toBe(false);
    expect(entry.transports.requests).toHaveLength(0);
  });
});

describe("the object surface", () => {
  test("listContainers reads databases, then schemas, and nothing below a schema", async () => {
    const entry = await connected({ database: "SALES", schema: "PUBLIC" });
    entry.transports.answer(
      SUBMIT,
      resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["SALES"], ["OTHER"]] }),
      resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["PUBLIC"]] }),
    );
    expect(await entry.provider.listContainers()).toEqual([
      { path: ["SALES"], name: "SALES", level: 0, isSessionDefault: true },
      { path: ["OTHER"], name: "OTHER", level: 0, isSessionDefault: false },
    ]);
    expect(await entry.provider.listContainers(["SALES"])).toEqual([
      { path: ["SALES", "PUBLIC"], name: "PUBLIC", level: 1, isSessionDefault: true },
    ]);
    expect(await entry.provider.listContainers(["SALES", "PUBLIC"])).toEqual([]);
    expect(submits(entry).map((r) => (bodyOf(r).parameters as Record<string, unknown>).query_tag)).toEqual([
      SNOWFLAKE_QUERY_TAGS.tree,
      SNOWFLAKE_QUERY_TAGS.tree,
    ]);
  });

  test("the configured schema is marked only in the configured database, so the agent walk keeps it", async () => {
    const entry = await connected({ database: "sales", schema: "public" });
    const names = (...rows: string[]) =>
      resultAnswer({ columns: [{ name: "name", type: "text" }], rows: rows.map((name) => [name]) });
    entry.transports.answer(SUBMIT, names("PUBLIC", "RAW"));
    expect(await entry.provider.listContainers(["OTHER"])).toEqual([
      { path: ["OTHER", "PUBLIC"], name: "PUBLIC", level: 1, isSessionDefault: false },
      { path: ["OTHER", "RAW"], name: "RAW", level: 1, isSessionDefault: false },
    ]);
    entry.transports.answer(SUBMIT, names("SALES", "OTHER"), names("PUBLIC", "STAGING"), names("PUBLIC", "RAW"));
    const enumeration = await enumerateContainers(entry.provider);
    expect(enumeration.defaultContainer).toEqual(["SALES", "PUBLIC"]);
    const scoped = scopeGroundingContainers(enumeration, entry.provider.getCapabilities().agentWalkScope);
    expect(scoped.enumeration.containers).toEqual([["SALES", "PUBLIC"]]);
  });

  test("with no configured database, no schema is marked", async () => {
    const entry = await connected({ schema: "PUBLIC" });
    entry.transports.answer(SUBMIT, resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["PUBLIC"]] }));
    expect(await entry.provider.listContainers(["SALES"])).toEqual([
      { path: ["SALES", "PUBLIC"], name: "PUBLIC", level: 1, isSessionDefault: false },
    ]);
  });

  test("a container or object path of the wrong shape is refused before anything is sent", async () => {
    const entry = await connected();
    expect(await caught(entry.provider.countObjects(["SALES"]))).toBeInstanceOf(QueryError);
    expect(await caught(entry.provider.describeObject(["SALES", "T"], "table"))).toBeInstanceOf(QueryError);
    expect(await caught(entry.provider.describeObject(["SALES", "PUBLIC", "T"], "nope"))).toBeInstanceOf(QueryError);
    expect(entry.transports.requests).toHaveLength(0);
  });

  test("describeObjects shares one schema column read for 10 s, then reads it again", async () => {
    const entry = await connected();
    const tables = () => resultAnswer({ columns: [{ name: "name", type: "text" }], rows: [["T"]] });
    const columns = () =>
      resultAnswer({
        columns: ["table_name", "column_name", "data_type", "null?"].map((name) => ({ name, type: "text" })),
        rows: [["T", "ID", '{"type":"FIXED","precision":38,"scale":0,"nullable":false}', "NOT_NULL"]],
      });
    entry.transports.answer(SUBMIT, tables(), columns(), tables(), tables(), columns());
    await entry.provider.describeObjects(["SALES", "PUBLIC"], "table");
    entry.clock.advance(9_999);
    await entry.provider.describeObjects(["SALES", "PUBLIC"], "table");
    entry.clock.advance(1);
    await entry.provider.describeObjects(["SALES", "PUBLIC"], "table");
    const columnReads = submits(entry).filter((r) => String(bodyOf(r).statement).startsWith("SHOW COLUMNS"));
    expect(columnReads).toHaveLength(2);
  });

  test("runMaintenance refuses every operation and sends nothing", async () => {
    const entry = await connected();
    const error = await caught(entry.provider.runMaintenance("kill", "1"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe("Snowflake has no maintenance operations in Studio.");
    expect((error as Error).message).toBe(SNOWFLAKE_PROVIDER_SENTENCES.maintenanceRefused);
    expect(entry.transports.requests).toHaveLength(0);
  });
});

describe("the declarations", () => {
  test("every capability of the features left off equals its declared value, read unconnected", () => {
    const capabilities = build().provider.getCapabilities();
    expect(capabilities).toMatchObject({
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "snowflake-json",
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsResultPagination: false,
      supportsColumnProfiling: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      identifierQuoting: "double-always",
      containerPathShapes: "exact",
      resumesBilledCompute: true,
      agentWalkScope: {
        mode: "session-default",
        whenNoDefault: { walk: "parent-default-children", skip: ["INFORMATION_SCHEMA"] },
      },
    });
    expect(capabilities.containerLevels).toEqual([
      { id: "catalog", label: "Database", labelPlural: "Databases" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ]);
    expect(capabilities.objectKinds).toBe(SNOWFLAKE_OBJECT_KINDS);
    expect(new RegExp(capabilities.schemaRefreshPattern, "i").test("  undrop table t")).toBe(true);
    expect(new RegExp(capabilities.schemaRefreshPattern, "i").test("select 1")).toBe(false);
  });

  test("no read-only path is declared", () => {
    expect("queryReadOnly" in build().provider).toBe(false);
  });

  test("the ten object kinds, in order, with columns on tables and views only", () => {
    expect(SNOWFLAKE_OBJECT_KINDS.map((kind) => [kind.id, kind.role, kind.label, kind.labelPlural])).toEqual([
      ["table", "relation", "Table", "Tables"],
      ["view", "relation", "View", "Views"],
      ["stream", "relation", "Stream", "Streams"],
      ["task", "config", "Task", "Tasks"],
      ["sequence", "config", "Sequence", "Sequences"],
      ["stage", "config", "Stage", "Stages"],
      ["file-format", "config", "File format", "File formats"],
      ["pipe", "config", "Pipe", "Pipes"],
      ["function", "routine", "Function", "Functions"],
      ["procedure", "routine", "Procedure", "Procedures"],
    ]);
    expect(SNOWFLAKE_OBJECT_KINDS.filter((kind) => kind.hasColumns === true).map((kind) => kind.id)).toEqual([
      "table",
      "view",
    ]);
    expect(SNOWFLAKE_OBJECT_KINDS.filter((kind) => kind.hasSource !== true).map((kind) => kind.id)).toEqual(["stage"]);
  });

  test("the labels name Snowflake's own terms and the two monitoring empty states", () => {
    const labels = build().provider.getLabels();
    expect(labels.entityName).toBe("Table");
    expect(labels.selectAction).toBe("Select Top 50");
    expect(labels.slowQueriesEmptyState).toBe(SNOWFLAKE_MONITORING_LABELS.slowQueriesEmptyState);
    expect(labels.sessionsEmptyState).toBe(SNOWFLAKE_MONITORING_LABELS.sessionsEmptyState);
    expect(labels.analyzeGlobalDesc).toContain("Snowflake");
    expect(labels.vacuumGlobalDesc).toContain("Snowflake");
  });

  test("the constructor validates nothing and opens nothing", () => {
    const entry = build({ host: "", user: "", role: "" });
    expect(entry.provider.isConnected()).toBe(false);
    expect(entry.transports.lanesBuilt()).toBe(0);
  });
});
