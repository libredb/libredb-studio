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
  toBackendError,
} from "../../src/host/backend-client";
import type { BackendExit, BackendLink } from "../../src/host/backend-supervisor";
import {
  type BackendApi,
  type BackendErrorCode,
  type ConnectionParams,
  type InitializeResult,
  METHODS,
} from "../../src/protocol";
import { EventEmitter } from "../fakes/vscode";
import { TEST_PASSWORD } from "../fakes/credentials";

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

/** A BackendLink over the host side of an in-memory pair, whose generation and lastExit the test sets. */
class FakeLink implements BackendLink {
  generation = 1;
  lastExit: BackendExit | undefined;
  stops = 0;
  private readonly willStop = new EventEmitter<void>();
  readonly onWillStop = this.willStop.event;

  constructor(readonly host: MessageConnection) {}

  async connection() {
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

const open: MessageConnection[] = [];

/** A client over a fresh pair; the child side records every request it receives as [method, params]. */
function setup(read: ConnectionSource["read"] = async () => PARAMS) {
  const { host, child } = pair();
  open.push(host, child);
  const received: [string, unknown][] = [];
  const reads: string[] = [];
  const link = new FakeLink(host);
  const source: ConnectionSource = {
    read: async (connectionId) => {
      reads.push(connectionId);
      return await read(connectionId);
    },
  };
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
  return { client: new BackendClient(link, source), link, host, received, reads, serve };
}

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
      const { client, received, reads, serve } = setup(async () => {
        if (unreadable) throw new Error("the profile is gone");
        return PARAMS;
      });
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
