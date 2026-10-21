// The Results view against the four v0 engines (part 4, "Where the criteria the dropped _electron e2e held are now
// proved"): Run goes through the real store, source, client, run registry and run service into ResultsViewPresenter,
// whose PageRunner is the run service, over one forked dist/backend.js, and every message it posts is cloned and read
// back through parseHostMessage as the webview reads it. The cases hold the backend's answers behind criteria 8 to 11
// as the host turns them into messages, the commit keyword connection/open answers (H1), and the shapes of the
// recorded sequences the browser leg renders.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executionUiFor } from "@/lib/db/execution-ui";
import { BackendClient } from "../../src/host/backend-client";
import { type BackendCrash, type BackendLink, BackendSupervisor } from "../../src/host/backend-supervisor";
import { ProfileConnectionSource } from "../../src/host/connections/connection-source";
import { ConnectionStore } from "../../src/host/connections/connection-store";
import type { ProfileEntry } from "../../src/host/connections/profile";
import { BindingStore } from "../../src/host/editor/bindings";
import { runQuery } from "../../src/host/editor/run-query";
import { RunRegistry } from "../../src/host/editor/run-registry";
import { RunService } from "../../src/host/editor/run-service";
import { OpenConnections } from "../../src/host/open-connections";
import { LOAD_MORE_REFUSED, type ResultsSurface, ResultsViewPresenter } from "../../src/host/results/results-presenter";
import {
  EXIT_NOTIFICATION,
  type InitializeResult,
  METHODS,
  type OpenResult,
  type QueryPage,
  type RunQueryParams,
  type TestConnectionResult,
  type WireConnection,
} from "../../src/protocol";
import { type HostToWebview, parseHostMessage } from "../../src/results-protocol";
import { type BackendSession, openSession } from "../backend-session";
import { FakeSetting } from "../fakes/connections-setting";
import { FakeTextDocument, FakeTextEditor } from "../fakes/documents";
import { MemorySecretStorage } from "../fakes/secret-storage";
import { CancellationTokenSource, languages, settings, Uri, window, workspace } from "../fakes/vscode";
import { EMPTY_AND_NOTICES, FAILURES, LOAD_MORE_ON_POSTGRES, MONGODB_DOCUMENTS } from "../fixtures/results-sequences";
import { type EngineService, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "./containers";
import { ENGINES, type EngineFixture } from "./engines";
import { type BackendRuntime, backendRuntime, forkBackend } from "./runtime";

const EXTENSION_ROOT = join(__dirname, "..", "..");
const POSTURE = { allowExternalFileAccess: false };

/** A PostgreSQL table the page-failure case pages by two and drops between the pages. */
const PAGED_SETUP = ["create table it_paged (n int)", "insert into it_paged (n) values (1), (2), (3), (4)"];
/** A PostgreSQL table criterion 10's UPDATE changes three rows of. */
const UPDATE_SETUP = ["create table it_update3 (n int)", "insert into it_update3 (n) values (1), (2), (3)"];
/** Criterion 11's collection: documents with different keys, one of them nested. */
const PEOPLE = "it_results_people";
const PEOPLE_SETUP = JSON.stringify({
  collection: PEOPLE,
  operation: "insertMany",
  documents: [
    { name: "Ada", address: { city: "Izmir" }, tags: ["a"] },
    { name: "Lin", nick: "l" },
  ],
});

/** The profile id of each fixture's connection. */
const profileId = (service: EngineService) => `it-results-${service}`;

/** A wire connection as the setting keeps it: its password moved to secretFields and returned as its one secret. */
function profileOf(wire: WireConnection): { entry: ProfileEntry; secrets: Record<string, string> } {
  const { password, ...rest } = wire;
  if (password === undefined) return { entry: rest, secrets: {} };
  return { entry: { ...rest, secretFields: ["password"] }, secrets: { password } };
}

/** An event that never fires. */
const never =
  <T>(): ((listener: (event: T) => unknown) => { dispose(): void }) =>
  () => ({ dispose: () => {} });

/** What a sequence's messages are, without the values a live run cannot repeat: rows, ids, statements and times. */
function shapeOf(sequence: readonly HostToWebview[]): unknown[] {
  return sequence.map((message) => {
    const shape: Record<string, unknown> = { type: message.type };
    if ("page" in message) {
      shape.pageKeys = Object.keys(message.page).sort();
      shape.paginationKeys = Object.keys(message.page.pagination).sort();
    }
    if ("grid" in message) shape.grid = message.grid;
    if ("failure" in message) {
      shape.kind = message.failure.kind;
      shape.failureKeys = Object.keys(message.failure).sort();
    }
    return shape;
  });
}

/** The runId of a runStarted message. */
function runIdOf(message: HostToWebview | undefined): string {
  assert.equal(message?.type, "runStarted", JSON.stringify(message));
  return (message as Extract<HostToWebview, { type: "runStarted" }>).runId;
}

/** One host side of the view: the client, registry, run service and presenter over a link, with what they recorded. */
interface Host {
  readonly client: BackendClient;
  readonly opened: OpenConnections;
  readonly runs: RunRegistry;
  readonly service: RunService;
  readonly presenter: ResultsViewPresenter;
  /** Every message posted, as the webview's guard read it back from a structured clone. */
  readonly posted: HostToWebview[];
  /** Every query/run the run service sent. */
  readonly sent: RunQueryParams[];
  /** Every warning the presenter logged. */
  readonly warnings: string[];
  /** How many queryIds the run service minted. */
  minted(): number;
  dispose(): void;
}

describe("the Results view against PostgreSQL, SQL Server, MySQL and MongoDB", () => {
  let runtime: BackendRuntime;
  let session: BackendSession | undefined;
  const engines = new Map<EngineService, RunningEngine>();
  let store: ConnectionStore;
  let bindings: BindingStore;
  let host: Host;
  let documents = 0;
  /** Each recorded fixture's live counterpart, by the fixture's name, filled by the cases that run it. */
  const live = new Map<string, HostToWebview[]>();

  const engineOf = (service: EngineService): RunningEngine => {
    const engine = engines.get(service);
    assert.ok(engine, `${service} is not running`);
    return engine;
  };
  const child = (): BackendSession => {
    assert.ok(session, "the child did not start");
    return session;
  };
  const running = (each: BackendSession): boolean => each.child.exitCode === null && each.child.signalCode === null;

  /** One statement on the fixture's setup connection, which the test opens outside the store and the client. */
  async function exec(service: EngineService, statement: string): Promise<QueryPage> {
    return await child().connection.sendRequest<QueryPage>(METHODS.runQuery, {
      connectionId: `${service}-setup`,
      queryId: randomUUID(),
      statement,
      limit: 500,
      offset: 0,
    });
  }

  /** connection/test once a second until one succeeds within START_DEADLINE_MS. */
  async function waitForLogin(fixture: EngineFixture): Promise<void> {
    const started = Date.now();
    const connection = fixture.connection(engineOf(fixture.service), `${fixture.service}-ready`);
    for (;;) {
      try {
        await child().connection.sendRequest<TestConnectionResult>(METHODS.testConnection, {
          connection,
          posture: POSTURE,
        });
        return;
      } catch (error) {
        if (Date.now() - started > START_DEADLINE_MS) {
          throw new Error(`${fixture.service} refused every login for ${START_DEADLINE_MS} ms: ${error}`, {
            cause: error,
          });
        }
      }
      await delay(1000);
    }
  }

  /** The view's host side over the link: a presenter whose PageRunner is the run service it presents for. */
  function hostOver(link: ConstructorParameters<typeof BackendClient>[0]): Host {
    const opened = new OpenConnections();
    const client = new BackendClient(link, new ProfileConnectionSource({ store, window, workspace }), opened);
    const runs = new RunRegistry(() => new CancellationTokenSource());
    const posted: HostToWebview[] = [];
    const sent: RunQueryParams[] = [];
    const warnings: string[] = [];
    let minted = 0;
    const surface: ResultsSurface = {
      // postMessage structured-clones the message, and the webview's guard refuses any shape it does not know.
      post: (message) => posted.push(parseHostMessage(structuredClone(message))),
      reveal: () => {},
      describe: () => {},
    };
    const presenter = new ResultsViewPresenter({
      surface,
      pages: { runPage: (read) => service.runPage(read) },
      log: {
        warn: (message: string) => warnings.push(message),
        error: (message: string | Error) => assert.fail(`the presenter logged an error: ${String(message)}`),
      },
      newRunId: () => randomUUID(),
      now: () => Date.now(),
    });
    const service = new RunService({
      client: {
        runQuery: (params, token) => {
          sent.push(params);
          return client.runQuery(params, token);
        },
        cancelQuery: (params) => client.cancelQuery(params),
      },
      runs,
      presenter,
      opened,
      window,
      newQueryId: () => {
        minted += 1;
        return randomUUID();
      },
    });
    return {
      client,
      opened,
      runs,
      service,
      presenter,
      posted,
      sent,
      warnings,
      minted: () => minted,
      dispose: () => {
        runs.dispose();
        opened.dispose();
      },
    };
  }

  /** A bound untitled document of the text, shown as the active editor, selected from anchor to active. */
  function editorFor(connectionId: string, text: string, anchor = 0, active = anchor): FakeTextEditor {
    documents += 1;
    const document = new FakeTextDocument(Uri.parse(`untitled:it-results-${documents}`), text);
    bindings.bind(document.uri.toString(), { connectionId });
    const editor = new FakeTextEditor(document, anchor, active);
    window.activeTextEditor = editor.asEditor();
    return editor;
  }

  /** Run's dependencies on `on`: the command's own code path from the active editor to the run service. */
  function depsOf(on: Host): Parameters<typeof runQuery>[0] {
    return {
      store,
      window,
      workspace,
      languages,
      client: on.client,
      bindings,
      runs: on.runs,
      service: on.service,
      log: window.createOutputChannel("LibreDB results test", { log: true }),
      timers: { setTimeout },
      showLog: () => Promise.resolve(),
      openUserSettings: () => Promise.resolve(),
      addConnection: () => Promise.resolve(),
    } as unknown as Parameters<typeof runQuery>[0];
  }

  /** Runs the text on a fresh document through Run, and answers what the presenter posted for it. */
  async function run(connectionId: string, text: string, anchor = 0, active = anchor): Promise<HostToWebview[]> {
    editorFor(connectionId, text, anchor, active);
    const from = host.posted.length;
    await runQuery(depsOf(host));
    return host.posted.slice(from);
  }

  /** The runSucceeded of a run's two messages, failing with the failure when the run failed. */
  function succeeded(messages: readonly HostToWebview[]): Extract<HostToWebview, { type: "runSucceeded" }> {
    assert.deepEqual(
      messages.map((message) => message.type),
      ["runStarted", "runSucceeded"],
      JSON.stringify(messages),
    );
    return messages[1] as Extract<HostToWebview, { type: "runSucceeded" }>;
  }

  /** Load More on the run, and what the presenter posted for it. */
  async function loadMore(runId: string): Promise<HostToWebview[]> {
    const from = host.posted.length;
    await host.presenter.loadMore(runId);
    return host.posted.slice(from);
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
    session = openSession(forkBackend(runtime));
    const initialized: InitializeResult = await session.initialize();
    await Promise.all(ENGINES.map((fixture) => waitForLogin(fixture)));
    for (const fixture of ENGINES) {
      const connection = fixture.connection(engineOf(fixture.service), `${fixture.service}-setup`);
      await child().connection.sendRequest<OpenResult>(METHODS.openConnection, { connection, posture: POSTURE });
      for (const statement of fixture.setup) await exec(fixture.service, statement);
    }
    for (const statement of [...PAGED_SETUP, ...UPDATE_SETUP]) await exec("postgres", statement);
    await exec("mongodb", PEOPLE_SETUP);

    const connection = session.connection;
    const link: BackendLink & { onDidCrash: (listener: (crash: BackendCrash) => unknown) => { dispose(): void } } = {
      connection: async () => ({ connection, generation: 1, initialized }),
      generation: 1,
      state: "ready",
      lastExit: undefined,
      onWillStop: never<void>(),
      onDidCrash: never<BackendCrash>(),
      stop: async () => {},
    };
    store = new ConnectionStore({
      setting: new FakeSetting([]),
      secrets: new MemorySecretStorage(),
      log: window.createOutputChannel("LibreDB results test store", { log: true }),
    });
    bindings = new BindingStore();
    host = hostOver(link);
    for (const fixture of ENGINES) {
      const { entry, secrets } = profileOf(fixture.connection(engineOf(fixture.service), profileId(fixture.service)));
      await store.add(entry, secrets);
    }
  });

  beforeEach(() => {
    settings.set("libredb.query.rowLimit", 2);
  });

  after(async function () {
    this.timeout(120_000);
    try {
      settings.delete("libredb.query.rowLimit");
      window.activeTextEditor = undefined;
      host?.dispose();
      bindings?.dispose();
      store?.dispose();
      if (session !== undefined && running(session)) {
        const exited = once(session.child, "exit");
        await session.connection.sendRequest(METHODS.shutdown);
        await session.connection.sendNotification(EXIT_NOTIFICATION);
        await exited;
        session.connection.dispose();
      }
    } finally {
      await Promise.all([...engines.values()].map((engine) => stopEngine(engine)));
      engines.clear();
    }
  });

  it("posts the commit keyword connection/open answers, the registry's for each engine (H1)", async () => {
    for (const fixture of ENGINES) {
      const id = profileId(fixture.service);
      const type = fixture.connection(engineOf(fixture.service), id).type;
      const expected = executionUiFor(type).commitKeyword;
      const text =
        fixture.service === "mongodb"
          ? JSON.stringify({ collection: "it_four", operation: "find", filter: {} })
          : "select 1";
      const { grid } = succeeded(await run(id, text));
      console.log(`${fixture.service}: commitKeyword ${JSON.stringify(grid.commitKeyword)}`);
      assert.equal(host.opened.get(id)?.description.commitKeyword, expected, fixture.service);
      assert.equal(grid.commitKeyword, expected, fixture.service);
      assert.equal(grid.databaseType, type);
    }
  });

  it("pages it_four by two through Load More on every engine whose description pages its results (criterion 8)", async () => {
    const paged: EngineService[] = [];
    for (const fixture of ENGINES) {
      const id = profileId(fixture.service);
      await host.client.ensureOpen(id);
      const description = host.opened.get(id)?.description;
      assert.ok(description, `${id} has no recorded description`);
      if (description.capabilities.supportsResultPagination !== true) continue;
      paged.push(fixture.service);

      const sentFrom = host.sent.length;
      const first = await run(id, fixture.selectFour);
      const { runId, page, grid } = succeeded(first);
      assert.equal(grid.supportsResultPagination, true);
      assert.deepEqual(
        page.rows.map((row) => Number(row.n)),
        [1, 2],
      );
      assert.equal(page.pagination.limit, 2);
      assert.equal(page.pagination.hasMore, true);
      assert.equal(host.sent.length, sentFrom + 1);
      const runQueryId = host.sent[sentFrom].queryId;

      const minted = host.minted();
      const started = Date.now();
      const more = await loadMore(runId);
      const elapsed = Date.now() - started;
      console.log(`${fixture.service}: the page read answered in ${elapsed} ms`);
      assert.equal(host.minted(), minted + 1, "the page read minted one queryId");
      assert.equal(host.sent.length, sentFrom + 2);
      const read = host.sent[sentFrom + 1];
      assert.equal(read.offset, 2);
      assert.equal(read.limit, 2);
      assert.equal(read.statement, fixture.selectFour);
      assert.notEqual(read.queryId, runQueryId);
      assert.deepEqual(
        more.map((message) => message.type),
        ["pageStarted", "pageAppended"],
        JSON.stringify(more),
      );
      const appended = more[1] as Extract<HostToWebview, { type: "pageAppended" }>;
      assert.equal(appended.runId, runId);
      assert.deepEqual(
        appended.page.rows.map((row) => Number(row.n)),
        [3, 4],
      );
      assert.equal(appended.page.pagination.offset, 2);
      assert.equal(appended.page.pagination.hasMore, false);
      if (fixture.service === "postgres") live.set("LOAD_MORE_ON_POSTGRES", [...first, ...more]);

      const warned = host.warnings.length;
      assert.deepEqual(await loadMore(runId), []);
      assert.deepEqual(host.warnings.slice(warned), [`Load More was refused: ${LOAD_MORE_REFUSED.noMore}.`]);
      assert.equal(host.sent.length, sentFrom + 2, "a refused Load More sent nothing");
    }
    console.log(`paged: ${paged.join(", ")}`);
    assert.ok(paged.includes("postgres"), `paged only ${paged.join(", ")}`);
  });

  describe("on PostgreSQL (criterion 9)", () => {
    const pg = profileId("postgres");

    it("posts a missing table's error as runFailed with the engine's sentence", async () => {
      const messages = await run(pg, "select * from it_missing");
      assert.deepEqual(
        messages.map((message) => message.type),
        ["runStarted", "runFailed"],
      );
      const { failure } = messages[1] as Extract<HostToWebview, { type: "runFailed" }>;
      console.log(`postgres: a missing table posts ${JSON.stringify(failure)}`);
      assert.equal(failure.kind, "error");
      assert.match((failure as { message: string }).message, /relation "it_missing" does not exist/);
      live.set("FAILURES.runFailed", messages);
    });

    it("posts a cancelled run as runFailed cancelled within 5 s", async () => {
      const editor = editorFor(pg, "select pg_sleep(30)");
      const uri = editor.document.uri.toString();
      const from = host.posted.length;
      const pending = runQuery(depsOf(host));
      while (host.runs.of(uri)?.phase !== "running") await delay(50);
      await delay(500);
      const cancelled = Date.now();
      await host.service.cancel(uri);
      await pending;
      const elapsed = Date.now() - cancelled;
      console.log(`postgres: the run ended ${elapsed} ms after Cancel`);
      assert.ok(elapsed < 5000, `${elapsed} ms`);
      const messages = host.posted.slice(from);
      assert.deepEqual(messages[1], {
        v: 1,
        type: "runFailed",
        runId: runIdOf(messages[0]),
        failure: { kind: "cancelled" },
      });
      assert.equal(messages.length, 2);
      live.set("FAILURES.cancelled", messages);
    });

    it("posts a page read of a dropped table as pageFailed, and replays the first page before it", async () => {
      const first = await run(pg, "select n from it_paged order by n");
      const { runId, page } = succeeded(first);
      assert.equal(page.pagination.hasMore, true);
      await exec("postgres", "drop table it_paged");
      const more = await loadMore(runId);
      assert.deepEqual(
        more.map((message) => message.type),
        ["pageStarted", "pageFailed"],
      );
      const { failure } = more[1] as Extract<HostToWebview, { type: "pageFailed" }>;
      console.log(`postgres: a page read of a dropped table posts ${JSON.stringify(failure)}`);
      assert.equal(failure.kind, "error");
      assert.match((failure as { message: string }).message, /relation "it_paged" does not exist/);
      assert.deepEqual(host.presenter.replay(), [...first, ...more]);
      live.set("FAILURES.pageFailed", [...first, ...more]);
    });

    it("posts a run whose child was killed as runFailed backendExited with SIGKILL", async () => {
      const supervisor = new BackendSupervisor({
        fork: (modulePath, args, options) => fork(modulePath, args, { ...options, execPath: runtime.execPath }),
        extensionPath: EXTENSION_ROOT,
        log: window.createOutputChannel("LibreDB results test supervisor", { log: true }),
        window,
        showLog: () => Promise.resolve(),
      });
      const own = hostOver(supervisor);
      try {
        const editor = editorFor(pg, "select pg_sleep(30)");
        const uri = editor.document.uri.toString();
        const pending = runQuery(depsOf(own));
        while (own.runs.of(uri)?.phase !== "running") await delay(50);
        await delay(500);
        const pid = supervisor.pid;
        assert.ok(pid !== undefined, "the supervisor holds no child");
        process.kill(pid, "SIGKILL");
        await pending;
        console.log(`postgres: a killed child posts ${JSON.stringify(own.posted.at(-1))}`);
        assert.equal(own.posted.length, 2);
        assert.deepEqual(own.posted[1], {
          v: 1,
          type: "runFailed",
          runId: runIdOf(own.posted[0]),
          failure: { kind: "backendExited", exitCode: null, signal: "SIGKILL" },
        });
        live.set("FAILURES.backendExited", own.posted);
      } finally {
        own.dispose();
        await supervisor.stop();
      }
    });
  });

  describe("on PostgreSQL (criterion 10)", () => {
    const pg = profileId("postgres");

    it("posts an UPDATE of three rows with rowCount 3 and no rows", async () => {
      const messages = await run(pg, "update it_update3 set n = n + 10");
      const { page } = succeeded(messages);
      assert.equal(page.rowCount, 3);
      assert.deepEqual(page.rows, []);
      live.set("EMPTY_AND_NOTICES.update3", messages);
    });

    it("posts a lone BEGIN as rolled back, with the engine's commit keyword", async () => {
      const messages = await run(pg, "BEGIN");
      const { page, grid } = succeeded(messages);
      assert.equal(page.openTransaction, "rolled-back");
      assert.equal(grid.commitKeyword, "COMMIT");
      live.set("EMPTY_AND_NOTICES.loneBegin", messages);
    });

    it("posts two result sets as the first set with resultSetCount 2", async () => {
      const text = "select 1; select 2";
      const messages = await run(pg, text, 0, text.length);
      const { page } = succeeded(messages);
      console.log(`postgres: two result sets post ${JSON.stringify(page)}`);
      assert.equal(page.resultSetCount, 2);
      assert.equal(page.rows.length, 1);
      assert.deepEqual(Object.values(page.rows[0]), [1]);
      live.set("EMPTY_AND_NOTICES.twoResultSets", messages);
    });
  });

  describe("on MongoDB (criterion 11)", () => {
    const id = profileId("mongodb");
    const find = JSON.stringify({ collection: PEOPLE, operation: "find", filter: {} });

    it("posts documents with the union of their keys, hex ids and a nested cell", async () => {
      const messages = await run(id, find);
      const { runId, page, grid } = succeeded(messages);
      console.log(`mongodb: a find posts ${JSON.stringify(page)}`);
      assert.deepEqual(page.fields, ["_id", "name", "address", "tags", "nick"]);
      for (const row of page.rows) assert.match(String(row._id), /^[0-9a-f]{24}$/);
      assert.deepEqual(page.rows[0].address, { city: "Izmir" });
      assert.deepEqual(page.rows[0].tags, ["a"]);
      assert.equal(page.pagination.hasMore, false);
      assert.equal(grid.supportsResultPagination, false);
      live.set("MONGODB_DOCUMENTS", messages);

      // Both documents fit the row limit, so the last page said no more rows follow, which criterion 7 checks first.
      const sent = host.sent.length;
      const warned = host.warnings.length;
      assert.deepEqual(await loadMore(runId), []);
      assert.deepEqual(host.warnings.slice(warned), [`Load More was refused: ${LOAD_MORE_REFUSED.noMore}.`]);
      assert.equal(host.sent.length, sent, "a refused Load More sent nothing");
    });
  });

  // Mocha runs a suite's own cases before its nested suites, so this suite, last, sees every live run above.
  describe("the recorded sequences", () => {
    it("match the shape of the live sequence of the same run", () => {
      // SYNTHETIC_RUN_FAILED_WITH_DETAIL is left out by name: no live run answers a detail yet (D389).
      const recorded: Readonly<Record<string, readonly HostToWebview[]>> = {
        LOAD_MORE_ON_POSTGRES,
        "FAILURES.runFailed": FAILURES.runFailed,
        "FAILURES.cancelled": FAILURES.cancelled,
        "FAILURES.backendExited": FAILURES.backendExited,
        "FAILURES.pageFailed": FAILURES.pageFailed,
        "EMPTY_AND_NOTICES.update3": EMPTY_AND_NOTICES.update3,
        "EMPTY_AND_NOTICES.loneBegin": EMPTY_AND_NOTICES.loneBegin,
        "EMPTY_AND_NOTICES.twoResultSets": EMPTY_AND_NOTICES.twoResultSets,
        MONGODB_DOCUMENTS,
      };
      const differences: string[] = [];
      for (const [name, fixture] of Object.entries(recorded)) {
        const measured = live.get(name);
        assert.ok(measured, `no live run recorded ${name}`);
        const want = JSON.stringify(shapeOf(fixture));
        const got = JSON.stringify(shapeOf(measured));
        if (want !== got) differences.push(`${name}\n  recorded ${want}\n  live     ${got}`);
      }
      assert.deepEqual(differences, [], differences.join("\n"));
    });
  });
});
