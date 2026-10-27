// The add-connection flow against the built child and the four v0 engines (part 2 criteria 2, 7, 8, 9 and 11):
// engines/list and connection/parse answer from the child, and the connection the flow builds from those answers and
// the typed fields is the one connection/test opens on PostgreSQL, SQL Server, MySQL and MongoDB.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ResponseError } from "vscode-jsonrpc/node";
import type { ConnectionField } from "@/lib/db/connection-fields";
import { CONNECTION_FORM, CONNECTION_PICKER_ORDER } from "@/lib/db/connection-form";
import { ENABLED_PROVIDERS } from "../../src/host/channel";
import {
  AddConnectionFlow,
  BACK_TO_REVIEW,
  type FlowInput,
  type FlowStep,
  notOffered,
  TEST_AGAIN,
  UNREADABLE_PASTE,
} from "../../src/host/connections/add-connection-flow";
import { FIELD_PROMPTS } from "../../src/host/connections/field-prompts";
import {
  type BackendErrorData,
  type ConnectionParams,
  type EngineCatalog,
  EXIT_NOTIFICATION,
  METHODS,
  type PastedConnection,
  type TestConnectionResult,
  type WireConnection,
} from "../../src/protocol";
import { type BackendSession, openSession } from "../backend-session";
import { TEST_PASSWORD } from "../fakes/credentials";
import { type EngineService, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "./containers";
import { ENGINES, type EngineFixture } from "./engines";
import { type BackendRuntime, backendRuntime, forkBackend } from "./runtime";

const EXTENSION_ROOT = join(__dirname, "..", "..");
/** The posture the flow's test sends in a trusted window; no v0 engine reads it. */
const TRUSTED = { allowExternalFileAccess: true };
/** A throwaway value no fixture uses. */
const WRONG_PASSWORD = ["not", "the", "fixture", "one"].join("-");

type TestStep = Extract<FlowStep, { kind: "test" }>;

const pick = (id: string): FlowInput => ({ kind: "pick", id });
const accept = (value: string): FlowInput => ({ kind: "accept", value });
const answered = (answer: TestConnectionResult): FlowInput => ({
  kind: "tested",
  outcome: { kind: "answered", answer },
});

/** The error answer of a request that must fail. */
async function errorOf(answer: Promise<unknown>): Promise<ResponseError<BackendErrorData | undefined>> {
  let value: unknown;
  try {
    value = await answer;
  } catch (error) {
    if (error instanceof ResponseError) return error;
    throw error;
  }
  assert.fail(`expected an error answer, got ${JSON.stringify(value)?.slice(0, 200)}`);
}

/** The field an input step asks, read from its title: "Add PostgreSQL Connection: Host" asks host. */
function askedField(step: FlowStep): ConnectionField {
  if (step.kind !== "input") assert.fail(`expected an input step, got ${step.kind}`);
  const label = step.title.split(": ").at(-1);
  const entry = Object.entries(FIELD_PROMPTS).find(([, prompt]) => prompt.label === label);
  assert.ok(entry, `no field is labelled ${label}`);
  return entry[0] as ConnectionField;
}

/** The values the walk types, by field: every string or number of the fixture's connection that names a field. */
function typedValues(connection: WireConnection): Partial<Record<ConnectionField, string>> {
  const values: Partial<Record<ConnectionField, string>> = {};
  for (const [key, value] of Object.entries(connection)) {
    if (key in FIELD_PROMPTS && (typeof value === "string" || typeof value === "number")) {
      values[key as ConnectionField] = String(value);
    }
  }
  return values;
}

function testStepOf(step: FlowStep): TestStep {
  if (step.kind !== "test") assert.fail(`expected the test step, got ${JSON.stringify(step).slice(0, 300)}`);
  return step;
}

/**
 * Walks a flow by details from the engine step: the engine, Enter connection details, then each box the flow asks,
 * typed from the connection. A connection with an SSL mode has it chosen in Review, which More Options opens from the
 * first box and whose Back returns to it. Answers the fields asked, in order, and the test step.
 */
function walkDetails(
  flow: AddConnectionFlow,
  connection: WireConnection,
): { asked: ConnectionField[]; test: TestStep } {
  const values = typedValues(connection);
  assert.equal(flow.advance(pick(connection.type)).kind, "pick");
  let step = flow.advance(pick("details"));
  const sslMode = connection.ssl?.mode;
  if (sslMode !== undefined) {
    flow.advance({ kind: "moreOptions" });
    flow.advance(pick("ssl"));
    flow.advance(pick(sslMode));
    step = flow.advance({ kind: "back" });
  }
  const asked: ConnectionField[] = [];
  while (step.kind === "input") {
    const field = askedField(step);
    asked.push(field);
    const value = values[field];
    assert.ok(value !== undefined, `the flow asked ${field}, which the fixture's connection does not set`);
    step = flow.advance(accept(value));
  }
  return { asked, test: testStepOf(step) };
}

/** Walks a flow for the engine by the paste step to the parse step, and answers the text it hands the child. */
function walkToParse(flow: AddConnectionFlow, type: string, text: string): string {
  assert.equal(flow.advance(pick(type)).kind, "pick");
  assert.equal(flow.advance(pick("paste")).kind, "input");
  const step = flow.advance(accept(text));
  if (step.kind !== "parse") assert.fail(`expected the parse step, got ${step.kind}`);
  return step.text;
}

const running = (session: BackendSession): boolean =>
  session.child.exitCode === null && session.child.signalCode === null;

describe("the add-connection flow on the built child against PostgreSQL, SQL Server, MySQL and MongoDB", () => {
  let runtime: BackendRuntime;
  let shared: BackendSession | undefined;
  let catalog: EngineCatalog;
  const engines = new Map<EngineService, RunningEngine>();
  const fresh: BackendSession[] = [];

  const sharedChild = (): BackendSession => {
    assert.ok(shared, "the shared child did not start");
    return shared;
  };
  const engineOf = (service: EngineService): RunningEngine => {
    const engine = engines.get(service);
    assert.ok(engine, `${service} is not running`);
    return engine;
  };
  const flowFor = (id: string): AddConnectionFlow =>
    new AddConnectionFlow({ catalog, id, savedNames: [], now: () => new Date() });
  const test = (connection: WireConnection): Promise<TestConnectionResult> =>
    sharedChild().connection.sendRequest<TestConnectionResult>(METHODS.testConnection, {
      connection,
      posture: TRUSTED,
    } satisfies ConnectionParams);
  const parse = (text: string): Promise<PastedConnection> =>
    sharedChild().connection.sendRequest<PastedConnection>(METHODS.parsePastedConnection, { text });

  /** connection/test of the fixture's connection, once a second, until one succeeds within START_DEADLINE_MS. */
  async function waitForLogin(fixture: EngineFixture): Promise<void> {
    const started = Date.now();
    const connection = fixture.connection(engineOf(fixture.service), `${fixture.service}-ready`);
    for (;;) {
      try {
        await test(connection);
        console.log(`${fixture.service}: connection/test succeeded after ${Date.now() - started} ms`);
        return;
      } catch (error) {
        if (Date.now() - started > START_DEADLINE_MS) {
          throw new Error(
            `${fixture.service} refused every login for ${START_DEADLINE_MS} ms; the last answer: ${error}`,
            { cause: error },
          );
        }
      }
      await delay(1000);
    }
  }

  before(async function () {
    this.timeout(900_000);
    runtime = await backendRuntime();
    console.log(`runtime ${runtime.name}: ${runtime.execPath}`);
    const runId = `${process.pid}-${Date.now()}`;
    const outcomes = await Promise.allSettled(
      ENGINES.map((fixture) => startEngine(fixture.service, runId, EXTENSION_ROOT)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") engines.set(outcome.value.service, outcome.value);
    }
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    shared = openSession(forkBackend(runtime));
    await shared.initialize();
    catalog = await shared.connection.sendRequest<EngineCatalog>(METHODS.listEngines, {});
    await Promise.all(ENGINES.map((fixture) => waitForLogin(fixture)));
  });

  afterEach(async () => {
    for (const session of fresh.splice(0)) {
      if (running(session)) {
        const exited = once(session.child, "exit");
        session.child.kill("SIGKILL");
        await exited;
      }
      session.connection.dispose();
    }
  });

  after(async function () {
    this.timeout(120_000);
    try {
      if (shared !== undefined && running(shared)) {
        const exited = once(shared.child, "exit");
        assert.equal(await shared.connection.sendRequest(METHODS.shutdown), null);
        await shared.connection.sendNotification(EXIT_NOTIFICATION);
        await exited;
        shared.connection.dispose();
      }
    } finally {
      await Promise.all([...engines.values()].map((engine) => stopEngine(engine)));
      engines.clear();
    }
  });

  it("lists the enabled engines in the picker's order, and constructs no provider to list them", async () => {
    const session = openSession(forkBackend(runtime));
    fresh.push(session);
    // Every byte the child wrote to stdout has been read once its pipes close.
    const closed = once(session.child, "close");
    await session.initialize();
    const listed = await session.connection.sendRequest<EngineCatalog>(METHODS.listEngines, {});
    assert.deepEqual(
      listed.engines.map((engine) => [engine.type, engine.label]),
      CONNECTION_PICKER_ORDER.filter((type) => ENABLED_PROVIDERS.includes(type)).map((type) => [
        type,
        CONNECTION_FORM[type].label,
      ]),
    );
    assert.deepEqual(listed, catalog);
    assert.equal(await session.connection.sendRequest(METHODS.shutdown), null);
    await session.connection.sendNotification(EXIT_NOTIFICATION);
    await closed;
    assert.ok(!session.stdout().includes("[DB] Creating"), session.stdout());
  });

  it("reads a pasted string in the child, and the flow takes, switches or refuses on that reading", async () => {
    const postgres = `postgresql://app:${TEST_PASSWORD}@db.example:6543/shop?sslmode=require`;
    const reading = await parse(postgres);
    assert.equal(reading.label, "PostgreSQL");
    assert.ok(reading.parsed);
    const { type, host, port, user, password, database, sslMode } = reading.parsed;
    assert.deepEqual(
      { type, host, port, user, password, database, sslMode },
      {
        type: "postgres",
        host: "db.example",
        port: "6543",
        user: "app",
        password: TEST_PASSWORD,
        database: "shop",
        sslMode: "require",
      },
    );
    let flow = flowFor("paste-postgres");
    assert.equal(walkToParse(flow, "postgres", postgres), postgres);
    const taken = testStepOf(flow.advance({ kind: "parsed", answer: reading })).connection;
    assert.deepEqual(
      { ...taken, createdAt: undefined },
      {
        id: "paste-postgres",
        name: "shop",
        type: "postgres",
        createdAt: undefined,
        host: "db.example",
        port: 6543,
        user: "app",
        password: TEST_PASSWORD,
        database: "shop",
        ssl: { mode: "require" },
      },
    );

    const srv = `mongodb+srv://app:${TEST_PASSWORD}@cluster0.example.net/orders`;
    const srvReading = await parse(srv);
    assert.equal(srvReading.label, "MongoDB");
    assert.ok(srvReading.parsed);
    assert.equal(srvReading.parsed.connectionString, srv);
    assert.equal(srvReading.parsed.sslMode, "verify-system");
    assert.equal(srvReading.parsed.database, "orders");
    flow = flowFor("paste-srv");
    walkToParse(flow, "mongodb", srv);
    const kept = testStepOf(flow.advance({ kind: "parsed", answer: srvReading })).connection;
    assert.equal(kept.connectionString, srv);
    assert.equal(kept.database, "orders");
    assert.deepEqual(kept.ssl, { mode: "verify-system" });
    for (const cleared of ["host", "port", "user", "password"]) assert.ok(!(cleared in kept), cleared);

    // A string for another engine continues as that engine.
    const mysql = `mysql://app:${TEST_PASSWORD}@db.example:3306/shop`;
    const mysqlReading = await parse(mysql);
    assert.equal(mysqlReading.parsed?.type, "mysql");
    assert.equal(mysqlReading.label, "MySQL");
    flow = flowFor("paste-mysql");
    walkToParse(flow, "postgres", mysql);
    const switched = testStepOf(flow.advance({ kind: "parsed", answer: mysqlReading }));
    assert.equal(switched.title, "Add MySQL Connection");
    assert.equal(switched.connection.type, "mysql");

    const oracle = `oracle://app:${TEST_PASSWORD}@db.example:1521/ORCL`;
    const oracleReading = await parse(oracle);
    assert.equal(oracleReading.parsed?.type, "oracle");
    assert.equal(oracleReading.label, "Oracle");
    flow = flowFor("paste-oracle");
    walkToParse(flow, "postgres", oracle);
    const refused = flow.advance({ kind: "parsed", answer: oracleReading });
    assert.equal(refused.kind === "input" && refused.validationMessage, notOffered("Oracle"));

    const unreadable = await parse("hello");
    assert.deepEqual(unreadable, { parsed: null, label: null });
    flow = flowFor("paste-hello");
    walkToParse(flow, "postgres", "hello");
    const again = flow.advance({ kind: "parsed", answer: unreadable });
    assert.equal(again.kind === "input" && again.validationMessage, UNREADABLE_PASTE);
  });

  for (const fixture of ENGINES) {
    it(`opens the connection the flow builds by details on ${fixture.service}`, async () => {
      const typed = fixture.connection(engineOf(fixture.service), `flow-${fixture.service}`);
      const flow = flowFor(`flow-${fixture.service}`);
      const { asked, test: step } = walkDetails(flow, typed);
      console.log(`${fixture.service}: the flow asked ${asked.join(", ")}; SSL mode ${typed.ssl?.mode ?? "none"}`);
      const connection = step.connection as unknown as Record<string, unknown>;
      for (const field of asked) {
        assert.equal(String(connection[field]), String((typed as unknown as Record<string, unknown>)[field]), field);
      }
      assert.deepEqual(step.connection.ssl, typed.ssl);
      const answer = await test(step.connection);
      assert.equal(answer.success, true);
      const latency = "latency" in answer ? answer.latency : undefined;
      assert.equal(typeof latency, "number", JSON.stringify(answer));
      const named = flow.advance(answered(answer));
      assert.equal(named.kind === "input" && named.prompt, `Connected in ${latency} ms. Name this connection.`);
    });
  }

  it("opens a MongoDB connection kept as the pasted string, with no host", async () => {
    const mongo = engineOf("mongodb");
    const { MONGO_INITDB_ROOT_USERNAME: user, MONGO_INITDB_ROOT_PASSWORD: password } = mongo.environment;
    const text = `mongodb://${user}:${password}@${mongo.host}:${mongo.port}/libredb_it?authSource=admin`;
    const flow = flowFor("paste-mongodb");
    walkToParse(flow, "mongodb", text);
    const step = testStepOf(flow.advance({ kind: "parsed", answer: await parse(text) }));
    assert.deepEqual(Object.keys(step.connection).sort(), [
      "connectionString",
      "createdAt",
      "database",
      "id",
      "name",
      "type",
    ]);
    assert.equal(step.connection.connectionString, text);
    const answer = await test(step.connection);
    assert.equal(answer.success, true, JSON.stringify(answer));
  });

  // A refused login fails the provider's connect, which raises a ConnectionError ("Failed to connect to <engine>: ..."),
  // so connection/test answers 503 CONNECTION_ERROR, as the web's test-connection route does, and not 401 AUTH_ERROR.
  for (const fixture of ENGINES) {
    it(`refuses a wrong password on ${fixture.service} with CONNECTION_ERROR, and the fixed password reaches Name`, async () => {
      const typed = fixture.connection(engineOf(fixture.service), `wrong-${fixture.service}`);
      const flow = flowFor(`wrong-${fixture.service}`);
      const { test: step } = walkDetails(flow, { ...typed, password: WRONG_PASSWORD });
      const error = await errorOf(test(step.connection));
      console.log(`${fixture.service}: a wrong password answered ${error.code} ${error.data?.code}`);
      assert.equal(error.code, 503, error.message);
      assert.equal(error.data?.code, "CONNECTION_ERROR", error.message);
      const fixStatement = error.data?.fixStatement;
      const dialog = flow.advance({
        kind: "tested",
        outcome: { kind: "failed", message: error.message, ...(fixStatement === undefined ? {} : { fixStatement }) },
      });
      assert.deepEqual(dialog.kind === "dialog" && [dialog.severity, dialog.message, dialog.buttons], [
        "error",
        error.message,
        [TEST_AGAIN, BACK_TO_REVIEW],
      ]);
      assert.equal(flow.advance({ kind: "dialog", choice: BACK_TO_REVIEW }).kind, "pick");
      assert.equal(flow.advance(pick("field:password")).kind, "input");
      assert.equal(flow.advance(accept(String(typed.password))).kind, "pick");
      const fixed = testStepOf(flow.advance(pick("test")));
      const answer = await test(fixed.connection);
      assert.equal(answer.success, true);
      const label = catalog.engines.find((engine) => engine.type === fixture.service)?.label;
      const named = flow.advance(answered(answer));
      assert.equal(named.kind === "input" && named.title, `Add ${label} Connection`);
    });
  }
});
