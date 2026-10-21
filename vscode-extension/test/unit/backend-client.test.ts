import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { type CancellationToken, CancellationTokenSource, ErrorCodes, ResponseError } from "vscode-jsonrpc";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  BackendClient,
  BackendError,
  BackendExitedError,
  type ConnectionSource,
  type SourcedConnection,
  toBackendError,
} from "../../src/host/backend-client";
import type { BackendExit, BackendLink, BackendState } from "../../src/host/backend-supervisor";
import { CredentialsNotGivenError } from "../../src/host/connections/connection-source";
import { UnknownConnectionError } from "../../src/host/connections/connection-store";
import {
  type BackendApi,
  type BackendErrorCode,
  type ConnectionParams,
  type InitializeResult,
  METHODS,
  type RunQueryParams,
} from "../../src/protocol";
import { EventEmitter } from "../fakes/vscode";
import { TEST_PASSWORD } from "../fakes/credentials";

/** A second stand-in password, built at run time as TEST_PASSWORD is. */
const RETYPED_PASSWORD = ["n3w", "2"].join("-");

const INITIALIZED: InitializeResult = {
  protocolVersion: 1,
  runtime: { node: "24.21.0", electron: "43.7.7", modules: "148", platform: "linux", arch: "x64" },
  enabledProviders: ["postgres", "mssql", "mysql", "mongodb"],
};
const PARAMS: ConnectionParams = {
  connection: {
    id: "c1",
    name: "Orders",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "app",
    password: TEST_PASSWORD,
    database: "orders",
    createdAt: "2026-10-20T10:00:00.000Z",
  },
  posture: { allowExternalFileAccess: false },
};
const OPENED = { description: { capabilities: {}, labels: {} } };
const RUN = { connectionId: "c1", queryId: "q-1", statement: "SELECT 1", limit: 500, offset: 0 };
const PAGE = { rows: [], fields: [], rowCount: 0, executionTime: 1 };

/** A BackendLink over the host side of an in-memory pair, whose generation, state and lastExit the test sets. */
class FakeLink implements BackendLink {
  generation = 1;
  state: BackendState = "ready";
  lastExit: BackendExit | undefined;
  stops = 0;
  /** How many times connection() ran: a call on a link that is not ready would start a child. */
  connections = 0;
  private readonly willStop = new EventEmitter<void>();
  readonly onWillStop = this.willStop.event;

  constructor(readonly host: MessageConnection) {}

  async connection() {
    this.connections += 1;
    return { connection: this.host, generation: this.generation, initialized: INITIALIZED };
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  fireWillStop(): void {
    this.willStop.fire();
  }
}

/** The host and child sides of one in-memory connection, as the IPC channel carries the same messages. */
function pair() {
  const up = new PassThrough();
  const down = new PassThrough();
  const host = createMessageConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
  const child = createMessageConnection(new StreamMessageReader(up), new StreamMessageWriter(down));
  return { host, child };
}

/**
 * A ConnectionSource whose params and revision the test sets: it records each read and each reask, and each opened()
 * as the number of requests the child had received when it ran.
 */
class FakeSource implements ConnectionSource {
  params: ConnectionParams = PARAMS;
  /** What revision() answers, and the revision read() answers it read at. */
  current = 0;
  readonly reads: string[] = [];
  readonly reasks: BackendError[] = [];
  readonly opened: number[] = [];

  constructor(private readonly received: readonly unknown[]) {}

  read = async (connectionId: string): Promise<SourcedConnection> => {
    this.reads.push(connectionId);
    return this.answer(this.params);
  };

  reask = async (_connectionId: string, error: BackendError): Promise<SourcedConnection | undefined> => {
    this.reasks.push(error);
    return undefined;
  };

  revision(): number {
    return this.current;
  }

  /** A read at the current revision whose opened() records into list. */
  answer(params: ConnectionParams, list: number[] = this.opened): SourcedConnection {
    return {
      params,
      revision: this.current,
      opened: async () => {
        list.push(this.received.length);
      },
    };
  }
}

const open: MessageConnection[] = [];

/** A client over a fresh pair; the child side records every request it receives as [method, params]. */
function setup() {
  const { host, child } = pair();
  open.push(host, child);
  const received: [string, unknown][] = [];
  const link = new FakeLink(host);
  const source = new FakeSource(received);
  const reads = source.reads;
  /** Scripts the child's handler for one method. */
  const serve = (method: string, handler: (params: unknown, token: CancellationToken) => unknown) => {
    child.onRequest(method, (params: unknown, token: CancellationToken) => {
      received.push([method, params]);
      return handler(params, token);
    });
  };
  serve(METHODS.openConnection, () => OPENED);
  host.listen();
  child.listen();
  return { client: new BackendClient(link, source), link, source, host, received, reads, serve };
}

const methods = (received: readonly [string, unknown][]) => received.map(([method]) => method);

/** The error a call rejected with; fails when it resolved. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  return await call.then(
    (value) => assert.fail(`expected a rejection, got ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/**
 * A child handler that answers only once its token is cancelled, and says so.
 * A cancel that reaches the child before the request is dispatched hands the handler a token already cancelled, whose
 * onCancellationRequested never fires, so the handler reads isCancellationRequested first, as the child's own do.
 */
function untilCancelled(cancelled: string[], label: string) {
  return (_params: unknown, token: CancellationToken) =>
    new Promise((resolve) => {
      const answer = () => {
        cancelled.push(label);
        resolve(PAGE);
      };
      if (token.isCancellationRequested) answer();
      else token.onCancellationRequested(answer);
    });
}

afterEach(() => {
  for (const connection of open.splice(0)) connection.dispose();
});

describe("BackendClient", () => {
  describe("error answers", () => {
    const CODED: [BackendErrorCode, number, object][] = [
      ["QUERY_CANCELLED", 499, {}],
      ["QUERY_ERROR", 400, { details: { position: 10, detail: "near FORM" } }],
      ["CONFIG_ERROR", 400, {}],
      ["AUTH_ERROR", 401, { fixStatement: "GRANT CONNECT ON DATABASE orders TO app;" }],
      ["PERMISSION_DENIED", 403, {}],
      ["TIMEOUT_ERROR", 504, { retryable: true }],
      ["CONNECTION_ERROR", 503, { retryable: true }],
      ["POOL_EXHAUSTED", 503, { retryable: true }],
      ["DATABASE_ERROR", 500, {}],
      ["INTERNAL_ERROR", 500, {}],
      ["SHUTTING_DOWN", 503, {}],
      ["PROTOCOL_MISMATCH", 500, {}],
      ["RUNTIME_UNSUPPORTED", 500, {}],
      ["TEXT_TOO_LARGE", 413, {}],
      ["CANCEL_UNSUPPORTED", 400, {}],
    ];
    for (const [code, status, more] of CODED) {
      it(`turns ${status} ${code} into a BackendError with its fields`, async () => {
        const { client, serve } = setup();
        serve(METHODS.testConnection, () => {
          throw new ResponseError(status, "m", { code, ...more });
        });
        const error = await rejection(client.testConnection(PARAMS));
        assert.ok(error instanceof BackendError);
        assert.equal(error.message, "m");
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.deepEqual(
          { retryable: error.retryable, details: error.details, fixStatement: error.fixStatement },
          { retryable: undefined, details: undefined, fixStatement: undefined, ...more },
        );
      });
    }

    for (const status of [ErrorCodes.InvalidParams, ErrorCodes.ServerNotInitialized]) {
      it(`gives ${status}, which carries no data.code, the code null`, async () => {
        const { client, serve } = setup();
        serve(METHODS.testConnection, () => {
          throw new ResponseError(status, "connectionId must be a non-empty string");
        });
        const error = await rejection(client.testConnection(PARAMS));
        assert.ok(error instanceof BackendError);
        assert.equal(error.status, status);
        assert.equal(error.code, null);
        assert.equal(error.message, "connectionId must be a non-empty string");
      });
    }
  });

  describe("a dead child", () => {
    it("rejects a waiting run with BackendExitedError once the connection is disposed", async () => {
      const { client, link, host, serve } = setup();
      serve(METHODS.runQuery, () => new Promise(() => {}));
      await client.openConnection(PARAMS);
      link.lastExit = { exitCode: null, signal: "SIGKILL" };
      const running = rejection(client.runQuery(RUN));
      await new Promise((resolve) => setImmediate(resolve));
      host.dispose();
      const error = await running;
      assert.ok(error instanceof BackendExitedError);
      assert.equal(error.exitCode, null);
      assert.equal(error.signal, "SIGKILL");
      assert.equal(error.message, "The LibreDB backend stopped (exit code none, signal SIGKILL).");
    });

    it("rejects a request sent on a disposed connection the same way", async () => {
      const { client, link, host } = setup();
      await client.openConnection(PARAMS);
      link.lastExit = { exitCode: 1, signal: null };
      host.dispose();
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendExitedError);
      assert.equal(error.message, "The LibreDB backend stopped (exit code 1, signal none).");
    });

    it("says so when a request was rejected while the backend had not exited", async () => {
      const { client, host, serve } = setup();
      serve(METHODS.runQuery, () => new Promise(() => {}));
      await client.openConnection(PARAMS);
      const running = rejection(client.runQuery(RUN));
      await new Promise((resolve) => setImmediate(resolve));
      host.dispose();
      const error = await running;
      assert.ok(error instanceof Error && !(error instanceof BackendExitedError));
      assert.equal(error.message, "A pending request was rejected while the LibreDB backend had not exited.");
    });
  });

  describe("tokens", () => {
    for (const [name, method, call] of [
      ["query/run", METHODS.runQuery, (client: BackendClient, token: CancellationToken) => client.runQuery(RUN, token)],
      [
        "objects/containers",
        METHODS.listContainers,
        (client: BackendClient, token: CancellationToken) => client.listContainers({ connectionId: "c1" }, token),
      ],
    ] as const) {
      it(`cancels the child's token for ${name} when the caller cancels`, async () => {
        const { client, serve } = setup();
        const cancelled: string[] = [];
        serve(method, untilCancelled(cancelled, name));
        await client.openConnection(PARAMS);
        const caller = new CancellationTokenSource();
        const answer = call(client, caller.token);
        await new Promise((resolve) => setImmediate(resolve));
        caller.cancel();
        await answer;
        assert.deepEqual(cancelled, [name]);
      });
    }

    it("cancels a running query/run when the link is about to stop", async () => {
      const { client, link, serve } = setup();
      const cancelled: string[] = [];
      serve(METHODS.runQuery, untilCancelled(cancelled, "query/run"));
      await client.openConnection(PARAMS);
      const answer = client.runQuery(RUN);
      await new Promise((resolve) => setImmediate(resolve));
      link.fireWillStop();
      assert.deepEqual(await answer, PAGE);
      assert.deepEqual(cancelled, ["query/run"]);
    });
  });

  describe("the one reopen", () => {
    it("reopens through the source and retries once on CONNECTION_NOT_OPEN", async () => {
      const { client, received, reads, serve } = setup();
      await client.openConnection(PARAMS);
      let refusals = 1;
      serve(METHODS.listContainers, () => {
        if (refusals-- > 0) throw new ResponseError(404, "not open", { code: "CONNECTION_NOT_OPEN" });
        return [];
      });
      assert.deepEqual(await client.listContainers({ connectionId: "c1" }), []);
      assert.deepEqual(reads, ["c1"]);
      assert.deepEqual(received, [
        [METHODS.openConnection, PARAMS],
        [METHODS.listContainers, { connectionId: "c1" }],
        [METHODS.openConnection, PARAMS],
        [METHODS.listContainers, { connectionId: "c1" }],
      ]);
    });

    it("rejects CONNECTION_NOT_OPEN after exactly two requests when the child refuses twice", async () => {
      const { client, received, serve } = setup();
      await client.openConnection(PARAMS);
      serve(METHODS.listContainers, () => {
        throw new ResponseError(404, "not open", { code: "CONNECTION_NOT_OPEN" });
      });
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "CONNECTION_NOT_OPEN");
      assert.equal(received.filter(([method]) => method === METHODS.listContainers).length, 2);
    });

    it("shares one reopen between concurrent reads the child refused with CONNECTION_NOT_OPEN", async () => {
      const { client, received, reads, serve } = setup();
      await client.openConnection(PARAMS);
      let refusals = 2;
      serve(METHODS.listContainers, () => {
        if (refusals-- > 0) throw new ResponseError(404, "not open", { code: "CONNECTION_NOT_OPEN" });
        return [];
      });
      assert.deepEqual(
        await Promise.all([
          client.listContainers({ connectionId: "c1" }),
          client.listContainers({ connectionId: "c1" }),
        ]),
        [[], []],
      );
      assert.deepEqual(reads, ["c1"]);
      assert.equal(received.filter(([method]) => method === METHODS.openConnection).length, 2);
    });

    it("does not retry any other code", async () => {
      const { client, received, reads, serve } = setup();
      await client.openConnection(PARAMS);
      serve(METHODS.listContainers, () => {
        throw new ResponseError(503, "refused", { code: "CONNECTION_ERROR", retryable: true });
      });
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "CONNECTION_ERROR");
      assert.deepEqual(reads, []);
      assert.equal(received.filter(([method]) => method === METHODS.listContainers).length, 1);
    });
  });

  describe("generations", () => {
    it("opens a connection again, once, in a new generation", async () => {
      const { client, link, received, reads, serve } = setup();
      serve(METHODS.listContainers, () => []);
      await client.openConnection(PARAMS);
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(reads, []);
      link.generation = 2;
      await client.listContainers({ connectionId: "c1" });
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(reads, ["c1"]);
      assert.deepEqual(
        received.map(([method]) => method),
        [
          METHODS.openConnection,
          METHODS.listContainers,
          METHODS.openConnection,
          METHODS.listContainers,
          METHODS.listContainers,
        ],
      );
    });

    it("shares one reopen between concurrent reads in a generation that has not opened the connection", async () => {
      const { client, link, received, reads, serve } = setup();
      serve(METHODS.listContainers, () => []);
      serve(METHODS.countObjects, () => ({}));
      await client.openConnection(PARAMS);
      link.generation = 2;
      await Promise.all([
        client.listContainers({ connectionId: "c1" }),
        client.countObjects({ connectionId: "c1", container: ["public"] }),
      ]);
      assert.deepEqual(reads, ["c1"]);
      assert.equal(received.filter(([method]) => method === METHODS.openConnection).length, 2);
    });

    it("keeps no reopen that failed, so the next read reads the source again", async () => {
      let unreadable = true;
      const { client, source, received, reads, serve } = setup();
      const read = source.read;
      source.read = async (connectionId) => {
        const sourced = await read(connectionId);
        if (unreadable) throw new Error("the profile is gone");
        return sourced;
      };
      serve(METHODS.listContainers, () => []);
      await assert.rejects(client.listContainers({ connectionId: "c1" }), /the profile is gone/);
      unreadable = false;
      assert.deepEqual(await client.listContainers({ connectionId: "c1" }), []);
      assert.deepEqual(reads, ["c1", "c1"]);
      assert.deepEqual(
        received.map(([method]) => method),
        [METHODS.openConnection, METHODS.listContainers],
      );
    });

    it("reopens before every object read and a run", async () => {
      const { client, received, reads, serve } = setup();
      serve(METHODS.countObjects, () => ({ table: { count: 1 } }));
      serve(METHODS.listObjects, () => []);
      serve(METHODS.describeObject, () => ({ columns: [] }));
      serve(METHODS.runQuery, () => PAGE);
      assert.deepEqual(await client.countObjects({ connectionId: "c1", container: ["public"] }), {
        table: { count: 1 },
      });
      assert.deepEqual(await client.listObjects({ connectionId: "c2", container: ["public"], kind: "table" }), []);
      assert.deepEqual(await client.describeObject({ connectionId: "c3", path: ["public", "t"], kind: "table" }), {
        columns: [],
      });
      assert.deepEqual(await client.runQuery({ ...RUN, connectionId: "c4" }), PAGE);
      assert.deepEqual(reads, ["c1", "c2", "c3", "c4"]);
      assert.deepEqual(
        received.map(([method]) => method),
        [
          METHODS.openConnection,
          METHODS.countObjects,
          METHODS.openConnection,
          METHODS.listObjects,
          METHODS.openConnection,
          METHODS.describeObject,
          METHODS.openConnection,
          METHODS.runQuery,
        ],
      );
    });

    it("never reopens for query/cancel", async () => {
      const { client, link, received, reads, serve } = setup();
      serve(METHODS.cancelQuery, () => ({ cancelled: false }));
      await client.openConnection(PARAMS);
      link.generation = 2;
      assert.deepEqual(await client.cancelQuery({ connectionId: "c1", queryId: "q-1" }), { cancelled: false });
      assert.deepEqual(reads, []);
      assert.deepEqual(received.at(-1), [METHODS.cancelQuery, { connectionId: "c1", queryId: "q-1" }]);
    });

    it("lets connection/test touch neither the record nor the source, and forgets a closed connection", async () => {
      const { client, received, reads, serve } = setup();
      serve(METHODS.testConnection, () => ({ success: true, message: "Connection successful", latency: 3 }));
      serve(METHODS.closeConnection, () => null);
      serve(METHODS.runQuery, () => PAGE);
      assert.deepEqual(await client.testConnection(PARAMS), {
        success: true,
        message: "Connection successful",
        latency: 3,
      });
      assert.deepEqual(reads, []);
      await client.openConnection(PARAMS);
      assert.equal(await client.closeConnection({ connectionId: "c1" }), null);
      await client.runQuery(RUN);
      assert.deepEqual(reads, ["c1"]);
      assert.deepEqual(
        received.map(([method]) => method),
        [
          METHODS.testConnection,
          METHODS.openConnection,
          METHODS.closeConnection,
          METHODS.openConnection,
          METHODS.runQuery,
        ],
      );
    });
  });

  describe("revisions (criterion 19, the client's half)", () => {
    it("reopens once, with the source's new params, after the revision moved", async () => {
      const { client, source, received, reads, serve } = setup();
      serve(METHODS.listContainers, () => []);
      await client.openConnection(PARAMS);
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(reads, []);
      const edited = { ...PARAMS, connection: { ...PARAMS.connection, host: "db2.internal" } };
      source.params = edited;
      source.current = 1;
      await client.listContainers({ connectionId: "c1" });
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(reads, ["c1"]);
      assert.deepEqual(received, [
        [METHODS.openConnection, PARAMS],
        [METHODS.listContainers, { connectionId: "c1" }],
        [METHODS.openConnection, edited],
        [METHODS.listContainers, { connectionId: "c1" }],
        [METHODS.listContainers, { connectionId: "c1" }],
      ]);
    });

    it("records the revision read answered, so an edit while the open waits reopens on the next request", async () => {
      const { client, source, received, serve } = setup();
      serve(METHODS.listContainers, () => []);
      serve(METHODS.openConnection, () => {
        source.current = 1;
        return OPENED;
      });
      await client.listContainers({ connectionId: "c1" });
      await client.listContainers({ connectionId: "c1" });
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(methods(received), [
        METHODS.openConnection,
        METHODS.listContainers,
        METHODS.openConnection,
        METHODS.listContainers,
        METHODS.listContainers,
      ]);
    });

    it("calls opened() once the child answered the reopen, and never after a failed one", async () => {
      const { client, source, serve } = setup();
      serve(METHODS.listContainers, () => []);
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(source.opened, [1]);
      serve(METHODS.openConnection, () => {
        throw new ResponseError(503, "refused", { code: "CONNECTION_ERROR", retryable: true });
      });
      source.current = 1;
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "CONNECTION_ERROR");
      assert.deepEqual(source.opened, [1]);
      // D387: a CONNECTION_ERROR open asks the source again; this one answers undefined, so the open stays failed.
      assert.deepEqual(
        source.reasks.map((error) => error.code),
        ["CONNECTION_ERROR"],
      );
    });

    it("never opens a connection the source cannot read (criterion 15)", async () => {
      const { client, source, received } = setup();
      source.read = async () => {
        throw new UnknownConnectionError("c1");
      };
      assert.ok((await rejection(client.listContainers({ connectionId: "c1" }))) instanceof UnknownConnectionError);
      assert.ok((await rejection(client.runQuery(RUN))) instanceof UnknownConnectionError);
      assert.deepEqual(received, []);
    });

    it("refuses a request on an opened connection the source no longer lists, sending nothing", async () => {
      const { client, source, received } = setup();
      await client.openConnection(PARAMS);
      source.revision = () => {
        throw new UnknownConnectionError("c1");
      };
      assert.ok((await rejection(client.listContainers({ connectionId: "c1" }))) instanceof UnknownConnectionError);
      assert.deepEqual(methods(received), [METHODS.openConnection]);
    });

    describe("with a reopen under way", () => {
      /** Ten event-loop turns: enough for the in-memory pair to carry every message sent so far. */
      const settle = (turns = 10): Promise<void> =>
        turns === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => setImmediate(resolve)).then(() => settle(turns - 1));

      /** The child holds every connection/open until the test releases them, and refuses the first `refusals`. */
      function heldOpens(serve: ReturnType<typeof setup>["serve"], refusals = 0) {
        const held = Promise.withResolvers<void>();
        serve(METHODS.openConnection, async () => {
          await held.promise;
          if (refusals-- > 0) throw new ResponseError(503, "refused", { code: "CONNECTION_ERROR", retryable: true });
          return OPENED;
        });
        return held;
      }

      it("shares it with no call that needs a newer revision, whose own reopen starts once it settled", async () => {
        const { client, source, received, reads, serve } = setup();
        serve(METHODS.listContainers, () => []);
        const held = heldOpens(serve);
        const first = client.listContainers({ connectionId: "c1" });
        await settle();
        assert.deepEqual(received, [[METHODS.openConnection, PARAMS]]);
        const edited = { ...PARAMS, connection: { ...PARAMS.connection, host: "db2.internal" } };
        source.params = edited;
        source.current = 1;
        const second = client.listContainers({ connectionId: "c1" });
        await settle();
        assert.deepEqual(methods(received), [METHODS.openConnection]);
        held.resolve();
        assert.deepEqual(await Promise.all([first, second]), [[], []]);
        assert.deepEqual(reads, ["c1", "c1"]);
        assert.deepEqual(received, [
          [METHODS.openConnection, PARAMS],
          [METHODS.listContainers, { connectionId: "c1" }],
          [METHODS.openConnection, edited],
          [METHODS.listContainers, { connectionId: "c1" }],
        ]);
      });

      it("opens at the newer revision though the reopen it waited for failed", async () => {
        const { client, source, received, serve } = setup();
        serve(METHODS.listContainers, () => []);
        const held = heldOpens(serve, 1);
        const first = rejection(client.listContainers({ connectionId: "c1" }));
        await settle();
        source.current = 1;
        const second = client.listContainers({ connectionId: "c1" });
        held.resolve();
        const error = await first;
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, "CONNECTION_ERROR");
        assert.deepEqual(await second, []);
        assert.deepEqual(methods(received), [METHODS.openConnection, METHODS.openConnection, METHODS.listContainers]);
      });

      it("closes, records nothing and rejects when the profile was removed while connection/open waited", async () => {
        const { client, source, received, serve } = setup();
        serve(METHODS.listContainers, () => []);
        serve(METHODS.closeConnection, () => null);
        const held = heldOpens(serve);
        const first = rejection(client.listContainers({ connectionId: "c1" }));
        await settle();
        // Remove: the store no longer lists the id, and its closeIfOpen finds no record yet.
        source.revision = () => {
          throw new UnknownConnectionError("c1");
        };
        await client.closeIfOpen("c1");
        held.resolve();
        assert.ok((await first) instanceof UnknownConnectionError);
        assert.deepEqual(received, [
          [METHODS.openConnection, PARAMS],
          [METHODS.closeConnection, { connectionId: "c1" }],
        ]);
      });

      it("keeps the child's connection when opened() fails for another reason", async () => {
        const { client, source, received, serve } = setup();
        serve(METHODS.closeConnection, () => null);
        const refused = new Error("the keyring refused the store");
        source.read = async () => ({
          ...source.answer(PARAMS),
          opened: async () => {
            throw refused;
          },
        });
        assert.equal(await rejection(client.listContainers({ connectionId: "c1" })), refused);
        assert.deepEqual(methods(received), [METHODS.openConnection]);
      });

      it("refuses a call for a connection the source no longer lists, sending nothing for it", async () => {
        const { client, source, received, serve } = setup();
        serve(METHODS.listContainers, () => []);
        serve(METHODS.closeConnection, () => null);
        const held = heldOpens(serve);
        const first = rejection(client.listContainers({ connectionId: "c1" }));
        await settle();
        source.revision = () => {
          throw new UnknownConnectionError("c1");
        };
        const second = rejection(client.listContainers({ connectionId: "c1" }));
        held.resolve();
        assert.ok((await first) instanceof UnknownConnectionError);
        assert.ok((await second) instanceof UnknownConnectionError);
        assert.deepEqual(methods(received), [METHODS.openConnection, METHODS.closeConnection]);
      });
    });
  });

  describe("Enter Credentials", () => {
    const RETYPED: ConnectionParams = { ...PARAMS, connection: { ...PARAMS.connection, password: RETYPED_PASSWORD } };

    /** The child refuses the first refusals connection/open requests with AUTH_ERROR and answers the rest. */
    function refuseOpens(serve: ReturnType<typeof setup>["serve"], refusals: number) {
      serve(METHODS.openConnection, () => {
        if (refusals-- > 0) {
          throw new ResponseError(401, 'password authentication failed for user "app"', { code: "AUTH_ERROR" });
        }
        return OPENED;
      });
    }

    it("opens again with what reask answered, then sends the request and runs that answer's opened()", async () => {
      const { client, source, received, serve } = setup();
      refuseOpens(serve, 1);
      serve(METHODS.listContainers, () => []);
      const typedOpened: number[] = [];
      source.reask = async (_connectionId, error) => {
        source.reasks.push(error);
        return source.answer(RETYPED, typedOpened);
      };
      assert.deepEqual(await client.listContainers({ connectionId: "c1" }), []);
      assert.deepEqual(received, [
        [METHODS.openConnection, PARAMS],
        [METHODS.openConnection, RETYPED],
        [METHODS.listContainers, { connectionId: "c1" }],
      ]);
      assert.deepEqual(
        source.reasks.map((error) => [error.status, error.code]),
        [[401, "AUTH_ERROR"]],
      );
      assert.deepEqual(typedOpened, [2]);
      assert.deepEqual(source.opened, []);
    });

    it("rejects the AUTH_ERROR after one open when reask answers undefined", async () => {
      const { client, source, received, serve } = setup();
      refuseOpens(serve, 1);
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "AUTH_ERROR");
      assert.deepEqual(methods(received), [METHODS.openConnection]);
      assert.equal(source.reasks.length, 1);
      assert.deepEqual(source.opened, []);
    });

    it("rejects with what reask rejects", async () => {
      const { client, source, received, serve } = setup();
      refuseOpens(serve, 1);
      const declined = new CredentialsNotGivenError("Orders");
      source.reask = async () => {
        throw declined;
      };
      assert.equal(await rejection(client.listContainers({ connectionId: "c1" })), declined);
      assert.deepEqual(methods(received), [METHODS.openConnection]);
    });

    it("retries the open once: a second refusal rejects without a third open", async () => {
      const { client, source, received, serve } = setup();
      refuseOpens(serve, 2);
      const typedOpened: number[] = [];
      source.reask = async (_connectionId, error) => {
        source.reasks.push(error);
        return source.answer(RETYPED, typedOpened);
      };
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "AUTH_ERROR");
      assert.deepEqual(methods(received), [METHODS.openConnection, METHODS.openConnection]);
      assert.equal(source.reasks.length, 1);
      assert.deepEqual(typedOpened, []);
    });

    // D387: the v0 providers answer a wrong password with 503 CONNECTION_ERROR, so that code offers Enter Credentials too.
    it("offers Enter Credentials on a CONNECTION_ERROR open and opens again with what reask answered", async () => {
      const { client, source, received, serve } = setup();
      let refusals = 1;
      serve(METHODS.openConnection, () => {
        if (refusals-- > 0) throw new ResponseError(503, "refused", { code: "CONNECTION_ERROR", retryable: true });
        return OPENED;
      });
      serve(METHODS.listContainers, () => []);
      const typedOpened: number[] = [];
      source.reask = async (_connectionId, error) => {
        source.reasks.push(error);
        return source.answer(RETYPED, typedOpened);
      };
      assert.deepEqual(await client.listContainers({ connectionId: "c1" }), []);
      assert.deepEqual(
        source.reasks.map((error) => [error.status, error.code]),
        [[503, "CONNECTION_ERROR"]],
      );
      assert.deepEqual(methods(received), [METHODS.openConnection, METHODS.openConnection, METHODS.listContainers]);
      assert.deepEqual(typedOpened, [2]);
    });

    it("rejects the CONNECTION_ERROR after one open when reask answers undefined (no secretFields)", async () => {
      const { client, source, received, serve } = setup();
      serve(METHODS.openConnection, () => {
        throw new ResponseError(503, "refused", { code: "CONNECTION_ERROR", retryable: true });
      });
      const error = await rejection(client.listContainers({ connectionId: "c1" }));
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, "CONNECTION_ERROR");
      assert.deepEqual(methods(received), [METHODS.openConnection]);
      assert.equal(source.reasks.length, 1);
    });

    for (const [code, status] of [
      ["TIMEOUT_ERROR", 504],
      ["CONFIG_ERROR", 400],
    ] as const) {
      it(`never offers Enter Credentials on a ${code} open`, async () => {
        const { client, source, received, serve } = setup();
        serve(METHODS.openConnection, () => {
          throw new ResponseError(status, "refused", { code });
        });
        const error = await rejection(client.listContainers({ connectionId: "c1" }));
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, code);
        assert.deepEqual(methods(received), [METHODS.openConnection]);
        assert.deepEqual(source.reasks, []);
      });
    }
  });

  describe("cancelRuns", () => {
    it("cancels the child's token of every run in flight on the id, and of no other", async () => {
      const { client, serve } = setup();
      const cancelled: string[] = [];
      serve(METHODS.runQuery, (params, token) =>
        untilCancelled(cancelled, (params as RunQueryParams).queryId)(params, token),
      );
      const runs = [
        client.runQuery({ ...RUN, queryId: "q-1" }),
        client.runQuery({ ...RUN, queryId: "q-2" }),
        client.runQuery({ ...RUN, connectionId: "c2", queryId: "q-3" }),
      ];
      await new Promise((resolve) => setImmediate(resolve));
      client.cancelRuns("c1");
      assert.deepEqual(await Promise.all(runs.slice(0, 2)), [PAGE, PAGE]);
      assert.deepEqual([...cancelled].sort(), ["q-1", "q-2"]);
      client.cancelRuns("c2");
      await runs[2];
      assert.deepEqual([...cancelled].sort(), ["q-1", "q-2", "q-3"]);
    });

    it("holds no run that settled, answered or refused", async () => {
      const { client, serve } = setup();
      serve(METHODS.runQuery, (params) => {
        if ((params as RunQueryParams).connectionId === "c2") {
          throw new ResponseError(400, "syntax error", { code: "QUERY_ERROR" });
        }
        return PAGE;
      });
      assert.deepEqual(await client.runQuery(RUN), PAGE);
      assert.ok((await rejection(client.runQuery({ ...RUN, connectionId: "c2" }))) instanceof BackendError);
      // Nothing outside the client can see a held token source, so the test reads its private map once.
      assert.equal((client as unknown as { runs: Map<string, unknown> }).runs.size, 0);
      client.cancelRuns("c1");
    });
  });

  describe("closeIfOpen", () => {
    it("closes a connection opened in the ready link's current generation once, and the next request reopens", async () => {
      const { client, received, reads, serve } = setup();
      serve(METHODS.closeConnection, () => null);
      serve(METHODS.listContainers, () => []);
      await client.openConnection(PARAMS);
      await client.closeIfOpen("c1");
      await client.closeIfOpen("c1");
      assert.deepEqual(
        received.filter(([method]) => method === METHODS.closeConnection),
        [[METHODS.closeConnection, { connectionId: "c1" }]],
      );
      await client.listContainers({ connectionId: "c1" });
      assert.deepEqual(reads, ["c1"]);
    });

    const LINKS: [string, (link: FakeLink) => void][] = [
      ["at generation 2", (link) => (link.generation = 2)],
      ["stopped", (link) => (link.state = "stopped")],
      ["failed", (link) => (link.state = "failed")],
      ["restarting", (link) => (link.state = "restarting")],
    ];
    for (const [label, change] of LINKS) {
      it(`sends nothing and starts no child with the link ${label}, and forgets the id`, async () => {
        const { client, link, received, reads, serve } = setup();
        serve(METHODS.listContainers, () => []);
        await client.openConnection(PARAMS);
        change(link);
        const connections = link.connections;
        await client.closeIfOpen("c1");
        assert.equal(link.connections, connections);
        assert.deepEqual(methods(received), [METHODS.openConnection]);
        link.generation = 1;
        link.state = "ready";
        await client.listContainers({ connectionId: "c1" });
        assert.deepEqual(reads, ["c1"]);
      });
    }

    it("sends nothing for an id never opened", async () => {
      const { client, link, received } = setup();
      await client.closeIfOpen("c1");
      assert.deepEqual(received, []);
      assert.equal(link.connections, 0);
    });
  });

  describe("engines/list and connection/parse", () => {
    it("sends each with its params as given and answers what the child answered, reading no connection", async () => {
      const { client, received, reads, serve } = setup();
      const catalogue = { engines: [] };
      const pasted = { parsed: null, label: null };
      serve(METHODS.listEngines, () => catalogue);
      serve(METHODS.parsePastedConnection, () => pasted);
      assert.deepEqual(await client.listEngines({}), catalogue);
      assert.deepEqual(await client.parsePastedConnection({ text: "postgres://x" }), pasted);
      assert.deepEqual(received, [
        [METHODS.listEngines, {}],
        [METHODS.parsePastedConnection, { text: "postgres://x" }],
      ]);
      assert.deepEqual(reads, []);
    });

    it("rejects with the child's refusal as a BackendError", async () => {
      const { client, serve } = setup();
      serve(METHODS.parsePastedConnection, () => {
        throw new ResponseError(ErrorCodes.InvalidParams, "text must be a string");
      });
      const error = await rejection(client.parsePastedConnection({ text: "x" }));
      assert.ok(error instanceof BackendError);
      assert.deepEqual([error.status, error.code, error.message], [-32602, null, "text must be a string"]);
    });
  });

  it("answers initialize with the link's handshake and sends nothing", async () => {
    const { client, received } = setup();
    const api: BackendApi = client;
    assert.deepEqual(await api.initialize({ protocolVersion: 1 }), INITIALIZED);
    assert.deepEqual(received, []);
  });

  it("answers shutdown with null once the link stopped", async () => {
    const { client, link, received } = setup();
    assert.equal(await client.shutdown(), null);
    assert.equal(link.stops, 1);
    assert.deepEqual(received, []);
  });
});

describe("toBackendError", () => {
  it("returns anything that is no answer of the child as it is", () => {
    const error = new TypeError("x is not a function");
    assert.equal(toBackendError(error, undefined), error);
  });
});
