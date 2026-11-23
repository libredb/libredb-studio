import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { type CancellationToken, CancellationTokenSource, ResponseError } from "vscode-jsonrpc";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { runEditorQuery } from "@/lib/api/editor-query";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { databaseErrorBody, internalErrorBody, TIMEOUT_SENTENCE } from "@/lib/api/error-body";
import {
  CONFIRMATION_FIELD_MESSAGE,
  CONFIRMATION_REQUIRED_MESSAGE,
  CONFIRMATION_TYPED_MESSAGE,
} from "@/lib/api/run-confirmation";
import { INVALID_RUN_CONFIRMATION_SETTING } from "@/lib/config/run-confirmation";
import { TYPED_NAME_MISSING_REFUSAL } from "@/lib/editor/statement-analysis";
import {
  consoleTextByteLimit,
  consoleTextOverLimit,
  NON_SQL_DESTRUCTIVE_VOCABULARY,
} from "@/lib/db/destructive-commands";
import { PROVIDER_TEXT_WITHHELD, providerTextScrub, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { executionUiFor } from "@/lib/db/execution-ui";
import { generateTableQuery } from "@/lib/query-generators";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { runTarget } from "@/lib/sql/run-target";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryCancelledError,
  QueryError,
  RefusedBeforeSendError,
  TimeoutError,
  connectPhase,
} from "@/lib/db/errors";
import type { Container, DatabaseObject, KindCount, ObjectDetail, ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema, QueryResult } from "@/lib/types";
import { engineCatalog } from "../../src/backend/engine-catalog";
import {
  type BackendFactory,
  type BackendHandlers,
  createHandlers,
  invalidParams,
  nodeMeetsFloor,
  RUN_CONFIRMATION_USER,
  RUN_ROUTE,
  refusal,
  registerHandlers,
  TEST_ROUTE,
  toResponseError,
} from "../../src/backend/handlers";
import { ConnectionRegistry } from "../../src/backend/registry";
import { ENABLED_PROVIDERS } from "../../src/host/channel";
import {
  type BackendErrorData,
  EXIT_NOTIFICATION,
  METHODS,
  type QueryPage,
  type RunTargetResult,
} from "../../src/protocol";
import {
  CAPS,
  type FakeProvider,
  fakeProvider,
  LABELS,
  type ProviderSurface,
  resultOf,
  rowsOf,
  SQL_CAPS,
} from "../fakes/provider";
import { TEST_PASSWORD } from "../fakes/credentials";

const WIRE = {
  id: "c1",
  name: "Orders",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  user: "app",
  password: TEST_PASSWORD,
  database: "orders",
  createdAt: "2026-10-20T10:00:00.000Z",
} as const;
/** An on-disk SQLite connection, the file-opening engine the extension enables. */
const SQLITE_WIRE = {
  id: "s1",
  name: "Local",
  type: "sqlite",
  database: "/home/you/app.db",
  createdAt: WIRE.createdAt,
};
const REVIVED = { ...WIRE, createdAt: new Date("2026-10-20T10:00:00.000Z") };
const POSTURE = { allowExternalFileAccess: true };
const RUNTIME = {
  versions: { ...process.versions, node: "24.21.0", electron: "43.7.7", modules: "148" },
  platform: "linux",
  arch: "x64",
  nodeFloor: ">=24.0.0",
};

function fakeFactory(provider: FakeProvider = fakeProvider(), over: Partial<BackendFactory> = {}) {
  const calls: unknown[][] = [];
  const factory: BackendFactory = {
    getOrCreateProvider: async (...args) => {
      calls.push(["getOrCreateProvider", ...args]);
      return provider;
    },
    removeProvider: async (...args) => {
      calls.push(["removeProvider", ...args]);
    },
    clearProviderCache: async () => {
      calls.push(["clearProviderCache"]);
    },
    enabledProviderTypes: () => ["postgres", "mssql", "mysql", "mongodb"],
    testConnection: async (...args) => {
      calls.push(["testConnection", ...args]);
      return { success: true, message: "Connection successful", latency: 12 };
    },
    ...over,
  };
  return { factory, calls };
}

/** The handlers over a fake factory, with the registry they write to. */
function backend(provider: FakeProvider = fakeProvider(), over: Partial<BackendFactory> = {}) {
  const { factory, calls } = fakeFactory(provider, over);
  const registry = new ConnectionRegistry();
  return { handlers: createHandlers(factory, RUNTIME, registry), factory, calls, registry, provider };
}

/** Asserts a ResponseError's code, message and data, exactly. */
function isRefusal(error: unknown, code: number, message: string, data?: unknown): true {
  assert.ok(error instanceof ResponseError, `expected a ResponseError, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.deepEqual(error.data, data);
  return true;
}

/** Rejects-with for a ResponseError: its code, message and data, exactly. */
async function refused(call: Promise<unknown>, code: number, message: string, data?: unknown): Promise<void> {
  await assert.rejects(call, (error) => isRefusal(error, code, message, data));
}

/** Throws-with for a ResponseError raised synchronously. */
function refusedNow(call: () => unknown, code: number, message: string, data?: unknown): void {
  assert.throws(call, (error) => isRefusal(error, code, message, data));
}

/** The answer to a provider step's failure on c1: `toResponseError` with the connection's scrub, as `answeringFor` gives. */
function answeredWithScrub(failure: unknown) {
  return toResponseError(failure, providerTextScrub(REVIVED, "any")).toJson();
}

/** Rejects-with for a provider step's failure on c1, answered as `answeredWithScrub` answers it. */
async function answeredAs(call: Promise<unknown>, failure: unknown): Promise<void> {
  await assert.rejects(call, (error) => {
    assert.ok(error instanceof ResponseError, `expected a ResponseError, got ${String(error)}`);
    assert.deepEqual(error.toJson(), answeredWithScrub(failure));
    return true;
  });
}

/**
 * The editor query reads the process's host core (src/lib/provider-host/instance.ts), so a block that runs it composes
 * its own and forgets it after: the unit leg is one Mocha process, where a hook at a file's top level would be a root
 * hook of every file.
 */
function composeHostCore(): void {
  before(() => installHostCore(createHostCore(), "test"));
  after(forgetHostCore);
}

describe("the child's refusals", () => {
  it("answers InvalidParams with no data, and its own refusals with a status and a code", () => {
    const params = invalidParams("connectionId must be a non-empty string");
    assert.equal(params.code, -32602);
    assert.equal(params.data, undefined);
    assert.deepEqual(params.toJson(), { code: -32602, message: "connectionId must be a non-empty string" });
    assert.deepEqual(refusal(404, "CONNECTION_NOT_OPEN", "gone").toJson(), {
      code: 404,
      message: "gone",
      data: { code: "CONNECTION_NOT_OPEN" },
    });
  });
});

describe("initialize", () => {
  it("answers the protocol version, the runtime and the enabled providers", () => {
    const { handlers } = backend();
    assert.deepEqual(handlers.initialize({ protocolVersion: 2 }), {
      protocolVersion: 2,
      runtime: { node: "24.21.0", electron: "43.7.7", modules: "148", platform: "linux", arch: "x64" },
      enabledProviders: ["postgres", "mssql", "mysql", "mongodb"],
    });
  });

  it("answers a null electron on plain Node and null providers when every provider is enabled", () => {
    const versions: NodeJS.ProcessVersions = { ...RUNTIME.versions };
    delete versions.electron;
    const { factory } = fakeFactory(fakeProvider(), { enabledProviderTypes: () => null });
    const answer = createHandlers(factory, { ...RUNTIME, versions }).initialize({ protocolVersion: 2 });
    assert.equal(answer.runtime.electron, null);
    assert.equal(answer.enabledProviders, null);
  });

  it("refuses another protocol version", () => {
    refusedNow(
      () => backend().handlers.initialize({ protocolVersion: 3 }),
      500,
      "The LibreDB backend speaks protocol version 2, but the extension sent version 3. Reinstall the LibreDB extension.",
      { code: "PROTOCOL_MISMATCH" },
    );
  });

  it("refuses a Node below the floor", () => {
    const { factory } = fakeFactory();
    const handlers = createHandlers(factory, { ...RUNTIME, versions: { ...RUNTIME.versions, node: "22.11.0" } });
    refusedNow(
      () => handlers.initialize({ protocolVersion: 2 }),
      500,
      "The LibreDB backend needs Node 24.0.0 or later and was started on Node 22.11.0.",
      { code: "RUNTIME_UNSUPPORTED" },
    );
  });

  it("refuses a protocol version that is not a number", () => {
    const { handlers } = backend();
    refusedNow(() => handlers.initialize({ protocolVersion: "1" }), -32602, "protocolVersion must be a number");
    refusedNow(() => handlers.initialize(undefined), -32602, "protocolVersion must be a number");
  });

  it("compares a Node version with the >=X.Y.Z floor, and refuses any other floor form", () => {
    assert.equal(nodeMeetsFloor("24.0.0", ">=24.0.0"), true);
    assert.equal(nodeMeetsFloor("23.11.1", ">=24.0.0"), false);
    assert.equal(nodeMeetsFloor("24.15.0", ">=24.15.1"), false);
    assert.equal(nodeMeetsFloor("25.0.0", ">=24.15.1"), true);
    assert.throws(() => nodeMeetsFloor("24.1.0", "^24"), {
      message: 'engines.node is "^24"; the backend\'s floor check reads only the ">=X.Y.Z" form.',
    });
  });
});

describe("connection/test", () => {
  it("runs the test connection core with the revived connection and an explicit posture, and stores nothing", async () => {
    const { handlers, calls, registry } = backend();
    assert.deepEqual(await handlers.testConnection({ connection: WIRE, posture: POSTURE }), {
      success: true,
      message: "Connection successful",
      latency: 12,
    });
    assert.equal(TEST_ROUTE, "vscode/connection/test");
    assert.deepEqual(calls, [["testConnection", REVIVED, { allowExternalFileAccess: true }, "vscode/connection/test"]]);
    assert.equal(registry.get("c1"), undefined);
  });

  it("refuses params it cannot read, naming the field, before any factory call", async () => {
    const { handlers, calls } = backend();
    const cases: [unknown, string][] = [
      [{ posture: POSTURE }, "connection must be an object"],
      [{ connection: { ...WIRE, id: 7 }, posture: POSTURE }, "connection.id must be a non-empty string"],
      [{ connection: { ...WIRE, id: "" }, posture: POSTURE }, "connection.id must be a non-empty string"],
      [{ connection: { ...WIRE, type: 1 }, posture: POSTURE }, "connection.type must be a string"],
      [
        { connection: { ...WIRE, createdAt: "yesterday" }, posture: POSTURE },
        "connection.createdAt must be an ISO date string",
      ],
      [{ connection: WIRE }, "posture.allowExternalFileAccess must be a boolean"],
      [{ connection: WIRE, posture: {} }, "posture.allowExternalFileAccess must be a boolean"],
      [
        { connection: WIRE, posture: { allowExternalFileAccess: "yes" } },
        "posture.allowExternalFileAccess must be a boolean",
      ],
    ];
    await Promise.all(cases.map(([params, sentence]) => refused(handlers.testConnection(params), -32602, sentence)));
    assert.deepEqual(calls, []);
  });

  it("refuses a file-opening connection the extension does not open, before any factory call", async () => {
    const { handlers, calls } = backend(fakeProvider(), { enabledProviderTypes: () => ["sqlite"] });
    const relative = { ...SQLITE_WIRE, database: "app.db" };
    await assert.rejects(handlers.testConnection({ connection: relative, posture: POSTURE }), DatabaseConfigError);
    await assert.rejects(
      handlers.testConnection({ connection: SQLITE_WIRE, posture: { allowExternalFileAccess: false } }),
      /Restricted Mode/,
    );
    assert.deepEqual(calls, []);
  });

  it("leaves a file-opening engine the channel does not enable to the factory's own refusal", async () => {
    const { handlers, calls } = backend();
    const restricted = {
      connection: { ...SQLITE_WIRE, database: "app.db" },
      posture: { allowExternalFileAccess: false },
    };
    await handlers.testConnection(restricted);
    assert.equal(calls[0][0], "testConnection");
  });

  describe("its deadline", () => {
    it("hands the core the connection, posture and route only, so the core's deadline bounds the test", async () => {
      const handed: unknown[][] = [];
      const { handlers } = backend(fakeProvider(), {
        testConnection: async (...args) => {
          handed.push(args);
          return { success: true, message: "Connection successful", latency: 1 };
        },
      });
      await handlers.testConnection({ connection: WIRE, posture: POSTURE });
      assert.deepEqual(handed, [[REVIVED, { allowExternalFileAccess: true }, TEST_ROUTE]]);
    });

    it("answers the core's deadline error as CONNECTION_ERROR with its sentence, its own status and code", async () => {
      const late = new ConnectionError(
        "The connection test got no answer within 70 seconds: check the address, the port, the network path and that the server is running.",
        "postgres",
      );
      const { handlers } = backend(fakeProvider(), { testConnection: () => Promise.reject(late) });
      await assert.rejects(handlers.testConnection({ connection: WIRE, posture: POSTURE }), (error) => {
        assert.ok(error instanceof ResponseError);
        assert.deepEqual(error.toJson(), {
          code: 503,
          message: late.message,
          data: { code: "CONNECTION_ERROR", retryable: true, kind: "connection", outcome: "unknown" },
        });
        return true;
      });
    });
  });
});

describe("connection/open", () => {
  it("answers the provider's description, with supportsQueryCancel read off its surface", async () => {
    const cancelling = backend(fakeProvider({ cancelQuery: async () => true }));
    assert.deepEqual(await cancelling.handlers.openConnection({ connection: WIRE, posture: POSTURE }), {
      description: {
        capabilities: { ...CAPS, supportsQueryCancel: true },
        labels: LABELS,
        editorLanguage: "sql",
        commitKeyword: executionUiFor(WIRE.type).commitKeyword,
      },
    });
    const plain = backend();
    assert.deepEqual(await plain.handlers.openConnection({ connection: WIRE, posture: POSTURE }), {
      description: {
        capabilities: { ...CAPS, supportsQueryCancel: false },
        labels: LABELS,
        editorLanguage: "sql",
        commitKeyword: executionUiFor(WIRE.type).commitKeyword,
      },
    });
  });

  it("answers the commit keyword the execution UI registry declares for the connection's type", async () => {
    for (const type of ENABLED_PROVIDERS) {
      const { handlers } = backend();
      // An absolute database, so a file-opening engine passes checkLocalFile and reaches the fake factory too.
      const connection = { ...WIRE, type, database: "/srv/orders" };
      const { description } = await handlers.openConnection({ connection, posture: POSTURE });
      assert.equal(description.commitKeyword, executionUiFor(type).commitKeyword);
    }
  });

  it("answers the editor language of the provider it opened, read from its capabilities", async () => {
    const json = { ...CAPS, queryLanguage: "json" } as ProviderCapabilities;
    const { handlers } = backend(fakeProvider({ getCapabilities: () => json }));
    const { description } = await handlers.openConnection({ connection: WIRE, posture: POSTURE });
    assert.equal(description.editorLanguage, "json");
  });

  it("opens through the factory with an explicit posture, never an owner or readOnly, and stores the record", async () => {
    const { handlers, calls, registry } = backend();
    await handlers.openConnection({ connection: WIRE, posture: { ...POSTURE, owner: "someone" } });
    assert.deepEqual(calls[0], ["getOrCreateProvider", REVIVED, {}, { allowExternalFileAccess: true }]);
    assert.deepEqual(Object.keys(calls[0][3] as object), ["allowExternalFileAccess"]);
    assert.deepEqual(registry.get("c1"), { connection: REVIVED, posture: POSTURE });
  });

  it("removes the old provider first only when the stored record differs", async () => {
    const { handlers, calls } = backend();
    await handlers.openConnection({ connection: WIRE, posture: POSTURE });
    await handlers.openConnection({ connection: WIRE, posture: POSTURE });
    assert.deepEqual(
      calls.map(([method]) => method),
      ["getOrCreateProvider", "getOrCreateProvider"],
    );
    await handlers.openConnection({ connection: { ...WIRE, password: "n3w" }, posture: POSTURE });
    assert.deepEqual(calls.slice(2), [
      ["removeProvider", "c1"],
      ["getOrCreateProvider", { ...REVIVED, password: "n3w" }, {}, { allowExternalFileAccess: true }],
    ]);
  });

  it("refuses a file-opening connection the extension does not open, before any factory call, and stores nothing", async () => {
    const { handlers, calls, registry } = backend(fakeProvider(), { enabledProviderTypes: () => ["sqlite"] });
    const relative = { ...SQLITE_WIRE, database: "app.db" };
    await assert.rejects(handlers.openConnection({ connection: relative, posture: POSTURE }), /absolute path/);
    assert.deepEqual(calls, []);
    assert.equal(registry.get(SQLITE_WIRE.id), undefined);
  });

  it("stores nothing when the open fails, and answers the factory's error as toResponseError answers it with the connection's scrub", async () => {
    const failure = new ConnectionError("connect ECONNREFUSED 127.0.0.1:5432", "postgres");
    const { handlers, factory, calls, registry } = backend();
    const open = factory.getOrCreateProvider;
    let fail = true;
    factory.getOrCreateProvider = async (...args) => {
      if (!fail) return open(...args);
      calls.push(["getOrCreateProvider", ...args]);
      throw failure;
    };
    await answeredAs(handlers.openConnection({ connection: WIRE, posture: POSTURE }), failure);
    assert.equal(registry.get("c1"), undefined);

    fail = false;
    await handlers.openConnection({ connection: WIRE, posture: POSTURE });
    fail = true;
    await answeredAs(handlers.openConnection({ connection: { ...WIRE, password: "n3w" }, posture: POSTURE }), failure);
    assert.deepEqual(calls.at(-2), ["removeProvider", "c1"]);
    assert.equal(registry.get("c1"), undefined);
  });
});

describe("one open or close of an id at a time", () => {
  /** Lets every promise the handlers chained run. */
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** Holds each getOrCreateProvider call until the test releases it. */
  function gated() {
    const opened = backend();
    const { factory } = opened;
    const open = factory.getOrCreateProvider;
    const gates: PromiseWithResolvers<void>[] = [];
    factory.getOrCreateProvider = async (...args) => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
      return await open(...args);
    };
    return { ...opened, gates };
  }

  it("runs a second open of an id after the first, which it then finds stored, and holds no other id", async () => {
    const { handlers, calls, gates } = gated();
    const first = handlers.openConnection({ connection: WIRE, posture: POSTURE });
    const second = handlers.openConnection({ connection: WIRE, posture: POSTURE });
    const other = handlers.openConnection({ connection: { ...WIRE, id: "c2" }, posture: POSTURE });
    await turn();
    assert.equal(gates.length, 2);
    for (const gate of gates) gate.resolve();
    await Promise.all([first, other]);
    await turn();
    assert.equal(gates.length, 3);
    gates[2].resolve();
    await second;
    assert.deepEqual(
      calls.map(([method]) => method),
      ["getOrCreateProvider", "getOrCreateProvider", "getOrCreateProvider"],
    );
  });

  it("runs a close of an id after the open of it under way, so nothing stays open", async () => {
    const { handlers, calls, registry, gates } = gated();
    const opening = handlers.openConnection({ connection: WIRE, posture: POSTURE });
    const closing = handlers.closeConnection({ connectionId: "c1" });
    await turn();
    assert.equal(calls.length, 0);
    gates[0].resolve();
    assert.equal((await Promise.all([opening, closing]))[1], null);
    assert.deepEqual(
      calls.map(([method]) => method),
      ["getOrCreateProvider", "removeProvider"],
    );
    assert.equal(registry.get("c1"), undefined);
  });
});

describe("connection/close", () => {
  it("removes the provider and the record, and does so again on a second close", async () => {
    const { handlers, calls, registry } = backend();
    await handlers.openConnection({ connection: WIRE, posture: POSTURE });
    assert.equal(await handlers.closeConnection({ connectionId: "c1" }), null);
    assert.deepEqual(calls.at(-1), ["removeProvider", "c1"]);
    assert.equal(registry.get("c1"), undefined);
    assert.equal(await handlers.closeConnection({ connectionId: "c1" }), null);
    assert.deepEqual(calls.at(-1), ["removeProvider", "c1"]);
    assert.equal(calls.length, 3);
  });

  it("refuses a connectionId that is not a non-empty string", async () => {
    await refused(
      backend().handlers.closeConnection({ connectionId: 3 }),
      -32602,
      "connectionId must be a non-empty string",
    );
  });
});

describe("object reads", () => {
  const CONTAINERS: Container[] = [{ path: ["app", "public"], name: "public", level: 1 }];
  const COUNTS: Record<string, KindCount> = { table: { count: 2 } };
  const OBJECTS: DatabaseObject[] = [{ path: ["app", "public", "orders"], name: "orders", kind: "table" }];
  const DETAIL: ObjectDetail = { path: ["app", "public", "orders"], columns: [], indexes: [], foreignKeys: [] };

  /** The handlers after an open of c1 under a posture that denies external file access. */
  async function opened(over: ProviderSurface = {}) {
    const made = backend(
      fakeProvider({
        listContainers: async () => CONTAINERS,
        countObjects: async () => COUNTS,
        listObjects: async () => OBJECTS,
        describeObject: async () => DETAIL,
        ...over,
      }),
    );
    await made.handlers.openConnection({ connection: WIRE, posture: { allowExternalFileAccess: false } });
    return made;
  }

  it("lists containers on the provider resolved under the record's posture, answering as it answered", async () => {
    const { handlers, provider, calls } = await opened();
    assert.equal(await handlers.listContainers({ connectionId: "c1", parent: ["app"] }), CONTAINERS);
    assert.deepEqual(provider.calls.at(-1), ["listContainers", ["app"]]);
    assert.deepEqual(calls.at(-1), ["getOrCreateProvider", REVIVED, {}, { allowExternalFileAccess: false }]);
    await handlers.listContainers({ connectionId: "c1" });
    assert.deepEqual(provider.calls.at(-1), ["listContainers", undefined]);
  });

  it("counts, lists and describes on the provider with the container, kind and path as sent", async () => {
    const { handlers, provider } = await opened();
    assert.deepEqual(await handlers.countObjects({ connectionId: "c1", container: ["app", "public"] }), COUNTS);
    assert.deepEqual(provider.calls.at(-1), ["countObjects", ["app", "public"]]);
    assert.equal(
      await handlers.listObjects({ connectionId: "c1", container: ["app", "public"], kind: "table" }),
      OBJECTS,
    );
    assert.deepEqual(provider.calls.at(-1), ["listObjects", ["app", "public"], "table"]);
    assert.equal(
      await handlers.describeObject({ connectionId: "c1", path: ["app", "public", "orders"], kind: "table" }),
      DETAIL,
    );
    assert.deepEqual(provider.calls.at(-1), ["describeObject", ["app", "public", "orders"], "table"]);
  });

  it("answers an object count's and description's sentences that hold the connection's credential withheld, and the clean ones as the provider answered them", async () => {
    const password = crypto.randomUUID();
    const counts: Record<string, KindCount> = {
      table: { unavailable: `permission denied for ${password}` },
      view: { count: 3, sampledFrom: `sampled by ${password}` },
      index: { count: 2 },
    };
    const detail: ObjectDetail = {
      path: ["app", "public", "orders"],
      columns: [],
      indexes: { unavailable: `pg_index is not readable by ${password}` },
      foreignKeys: [],
    };
    const cleanCounts: Record<string, KindCount> = {
      table: { unavailable: "permission denied" },
      view: { count: 3, sampledFrom: "a sample" },
    };
    const cleanDetail: ObjectDetail = { ...detail, indexes: { unavailable: "pg_index is not readable" } };
    let answer: { counts: Record<string, KindCount>; detail: ObjectDetail } = { counts, detail };
    const made = backend(
      fakeProvider({ countObjects: async () => answer.counts, describeObject: async () => answer.detail }),
    );
    await made.handlers.openConnection({
      connection: { ...WIRE, password },
      posture: { allowExternalFileAccess: false },
    });
    const counted = await made.handlers.countObjects({ connectionId: "c1", container: ["app", "public"] });
    assert.deepEqual(counted, {
      table: { unavailable: PROVIDER_TEXT_WITHHELD },
      view: { count: 3, sampledFrom: PROVIDER_TEXT_WITHHELD },
      index: { count: 2 },
    });
    const described = await made.handlers.describeObject({
      connectionId: "c1",
      path: ["app", "public", "orders"],
      kind: "table",
    });
    assert.deepEqual(described, { ...detail, indexes: { unavailable: PROVIDER_TEXT_WITHHELD } });
    assert.equal(JSON.stringify([counted, described]).includes(password), false);

    answer = { counts: cleanCounts, detail: cleanDetail };
    assert.deepEqual(await made.handlers.countObjects({ connectionId: "c1", container: ["app"] }), cleanCounts);
    assert.deepEqual(
      await made.handlers.describeObject({ connectionId: "c1", path: ["app", "public", "orders"], kind: "table" }),
      cleanDetail,
    );
  });

  it("refuses params it cannot read, naming the field, before resolving a provider", async () => {
    const { handlers, calls } = await opened();
    const before = calls.length;
    await refused(
      handlers.listContainers({ connectionId: "c1", parent: ["app", 1] }),
      -32602,
      "parent must be an array of strings",
    );
    await refused(handlers.countObjects({ connectionId: "c1" }), -32602, "container must be an array of strings");
    await refused(
      handlers.listObjects({ connectionId: "c1", container: ["app"], kind: 5 }),
      -32602,
      "kind must be a string",
    );
    await refused(
      handlers.describeObject({ connectionId: "c1", path: "app", kind: "table" }),
      -32602,
      "path must be an array of strings",
    );
    await refused(handlers.listContainers({}), -32602, "connectionId must be a non-empty string");
    assert.equal(calls.length, before);
  });

  it("refuses a connection this backend has not opened, before resolving a provider", async () => {
    const { handlers, calls } = await opened();
    const before = calls.length;
    await refused(
      handlers.listContainers({ connectionId: "c9" }),
      404,
      'No connection with id "c9" is open in this LibreDB backend.',
      { code: "CONNECTION_NOT_OPEN" },
    );
    assert.equal(calls.length, before);
  });

  it("answers a provider's error as toResponseError answers it with the connection's scrub", async () => {
    const denied = new PermissionDeniedError("permission denied for schema app", "postgres");
    const { handlers } = await opened({
      listObjects: async () => {
        throw denied;
      },
    });
    await answeredAs(handlers.listObjects({ connectionId: "c1", container: ["app"], kind: "table" }), denied);
  });

  it("answers a provider error's SQLSTATE in data", async () => {
    const missing = new QueryError('relation "app" does not exist', "postgres");
    missing.sqlstate = "42P01";
    const { handlers } = await opened({
      listContainers: async () => {
        throw missing;
      },
    });
    await assert.rejects(handlers.listContainers({ connectionId: "c1" }), (error) => {
      assert.ok(error instanceof ResponseError);
      assert.equal((error.data as BackendErrorData).sqlState, "42P01");
      return true;
    });
  });
});

const RUN = { connectionId: "c1", queryId: "q-1", statement: "SELECT n FROM t", limit: 2, offset: 0 };
const idle = new CancellationTokenSource().token;

/** The handlers after an open of `connection` on `provider`, with the provider's calls of the open cleared. */
async function openedOn(provider: FakeProvider = fakeProvider(), connection: object = WIRE) {
  const made = backend(provider);
  await made.handlers.openConnection({ connection, posture: POSTURE });
  provider.calls.length = 0;
  return made;
}

const methodsOf = (provider: FakeProvider) => provider.calls.map(([method]) => method);

/** Lets every promise the run awaits settle, so a provider call the run makes next has been made. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Clears LIBREDB_RUN_CONFIRMATION before each test of the enclosing describe and puts it back after each. */
function restoresRunConfirmationMode(): void {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;
  beforeEach(() => {
    delete process.env.LIBREDB_RUN_CONFIRMATION;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
  });
}

/** What an offer reads as once `shaped` has checked its token and expiry: the gate asks, nothing typed. */
const ASKED = {
  token: "<token>",
  expiresAt: "<expiry>",
  unreadable: false,
  typedConfirmation: null,
  classificationFailed: false,
};

/** The target's answer with its offer's token and expiry checked for shape and replaced by `ASKED`'s words. */
function shaped(answer: RunTargetResult): RunTargetResult {
  const offer = answer.confirmation;
  assert.ok(offer !== null, "expected an offer");
  assert.equal(typeof offer.token, "string");
  assert.ok(offer.token.length > 0);
  assert.equal(new Date(offer.expiresAt).toISOString(), offer.expiresAt);
  return { ...answer, confirmation: { ...offer, token: ASKED.token, expiresAt: ASKED.expiresAt } };
}

describe("query/run", () => {
  composeHostCore();

  it("answers the query route's body for the same provider outputs (criterion 5)", async () => {
    const { handlers } = await openedOn();
    const answer = await handlers.runQuery(RUN, idle);
    const body = {
      rows: [{ n: 1 }, { n: 2 }],
      fields: ["n"],
      rowCount: 2,
      executionTime: 3,
      pagination: { limit: 2, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
    };
    assert.deepEqual(answer, body);
    const route = await runEditorQuery(fakeProvider(), {
      statement: "SELECT n FROM t",
      options: { limit: 2, offset: 0 },
      queryId: "q-1",
      signal: new AbortController().signal,
      route: "test",
      scrub: providerTextScrub({ ...WIRE, createdAt: new Date(WIRE.createdAt) }, "any"),
    });
    assert.deepEqual(route.body, body);
    assert.equal("explainFormat" in answer, false);
    assert.equal("resultSetCount" in answer, false);
  });

  it("calls the provider as the query route calls it, handing it the run's id only when it can cancel", async () => {
    const plain = await openedOn();
    await plain.handlers.runQuery(RUN, idle);
    const [prepare, probe, query] = plain.provider.calls;
    assert.deepEqual(prepare, ["prepareQuery", "SELECT n FROM t", { limit: 2, offset: 0 }]);
    assert.deepEqual(probe, ["prepareQuery", "SELECT n FROM t", { limit: 3, offset: 0, unlimited: false }]);
    assert.deepEqual(query.slice(0, 4), ["query", "SELECT n FROM t LIMIT 3 OFFSET 0", undefined, undefined]);
    assert.equal(typeof query[4], "string");

    const cancelling = await openedOn(fakeProvider({ cancelQuery: async () => true }));
    await cancelling.handlers.runQuery(RUN, idle);
    assert.deepEqual(methodsOf(cancelling.provider), ["prepareQuery", "prepareQuery", "query"]);
    assert.deepEqual(cancelling.provider.calls[2].slice(0, 4), [
      "query",
      "SELECT n FROM t LIMIT 3 OFFSET 0",
      undefined,
      "q-1",
    ]);
  });

  it("answers resultSetCount only when the text produced more than one result set", async () => {
    const setsOf = (count: number) =>
      fakeProvider({ query: async () => resultOf(rowsOf(1), { resultSets: Array(count).fill(resultOf(rowsOf(1))) }) });
    const two = await openedOn(setsOf(2));
    assert.equal((await two.handlers.runQuery(RUN, idle)).resultSetCount, 2);
    const one = await openedOn(setsOf(1));
    assert.equal("resultSetCount" in (await one.handlers.runQuery(RUN, idle)), false);
  });

  it("answers a transaction the statement left open as rolled back (D74)", async () => {
    const { handlers } = await openedOn(fakeProvider({ endOpenQueryTransaction: async () => "rolled-back" }));
    assert.equal((await handlers.runQuery(RUN, idle)).openTransaction, "rolled-back");
  });

  it("runs in the catalog asked for only where the provider has catalog sessions", async () => {
    const sales = fakeProvider();
    const server = fakeProvider({
      getCapabilities: () => ({ ...CAPS, catalogSessions: true }),
      forCatalog: async () => sales,
    });
    const scoped = await openedOn(server);
    await scoped.handlers.runQuery({ ...RUN, catalog: "sales" }, idle);
    assert.deepEqual(server.calls, [["getCapabilities"], ["forCatalog", "sales"]]);
    assert.deepEqual(methodsOf(sales), ["prepareQuery", "prepareQuery", "query"]);

    const { handlers } = await openedOn();
    await answeredAs(
      handlers.runQuery({ ...RUN, catalog: "sales" }, idle),
      new DatabaseConfigError(
        'This postgres connection runs every request in its own database and cannot run one in "sales"',
        "postgres",
      ),
    );
    await refused(handlers.runQuery({ ...RUN, catalog: "" }, idle), -32602, "catalog must be a non-empty string");
  });

  it("refuses params it cannot read, naming the field, before resolving a provider", async () => {
    const { handlers, calls } = await openedOn();
    const before = calls.length;
    await refused(
      handlers.runQuery({ ...RUN, limit: -1 }, idle),
      -32602,
      "options.limit must be a non-negative integer",
    );
    await refused(
      handlers.runQuery({ ...RUN, offset: 1.5 }, idle),
      -32602,
      "options.offset must be a non-negative integer",
    );
    await refused(handlers.runQuery({ ...RUN, queryId: "" }, idle), -32602, "queryId must be a non-empty string");
    await refused(handlers.runQuery({ ...RUN, statement: 5 }, idle), -32602, "statement must be a string");
    await refused(
      handlers.runQuery({ ...RUN, connectionId: 4 }, idle),
      -32602,
      "connectionId must be a non-empty string",
    );
    assert.equal(calls.length, before);
  });

  it("refuses a connection this backend has not opened", async () => {
    const { handlers } = await openedOn();
    await refused(
      handlers.runQuery({ ...RUN, connectionId: "c9" }, idle),
      404,
      'No connection with id "c9" is open in this LibreDB backend.',
      { code: "CONNECTION_NOT_OPEN" },
    );
  });

  it("refuses a connection whose statement timeout is not a whole number of milliseconds before resolving a provider", async () => {
    const { handlers, calls } = backend();
    await handlers.openConnection({ connection: { ...WIRE, id: "c2", queryTimeout: "60000" }, posture: POSTURE });
    await refused(
      handlers.runQuery({ ...RUN, connectionId: "c2" }, idle),
      -32602,
      "The connection's queryTimeout must be a whole number of milliseconds from 1 to 2147483647.",
    );
    assert.deepEqual(calls.filter(([method]) => method === "getOrCreateProvider").length, 1);
  });

  it("refuses a text over its type's console bound before resolving a provider (TEXT_TOO_LARGE)", async () => {
    const { handlers, calls } = backend();
    await handlers.openConnection({ connection: { ...WIRE, id: "c2", type: "influxdb" }, posture: POSTURE });
    const bound = consoleTextByteLimit("influxdb");
    assert.ok(bound !== undefined);
    const text = "x".repeat(bound + 1);
    const sentence = consoleTextOverLimit(text, bound);
    assert.ok(sentence !== undefined);
    await refused(handlers.runQuery({ ...RUN, connectionId: "c2", statement: text }, idle), 413, sentence, {
      code: "TEXT_TOO_LARGE",
    });
    assert.deepEqual(calls.filter(([method]) => method === "getOrCreateProvider").length, 1);
  });

  it("cancels the statement on the engine once when the request's token is cancelled", async () => {
    let fail: (error: unknown) => void = () => {};
    const held = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const provider = fakeProvider({ cancelQuery: async () => true, query: () => held });
    const { handlers } = await openedOn(provider);
    const source = new CancellationTokenSource();
    const run = handlers.runQuery(RUN, source.token);
    await settled();
    assert.deepEqual(methodsOf(provider), ["prepareQuery", "prepareQuery", "query"]);
    source.cancel();
    source.cancel();
    // The host answers the run at the cancellation, outcome unknown, and has sent the engine's cancel once by then.
    await answeredAs(run, new QueryCancelledError("The query was cancelled."));
    assert.deepEqual(
      provider.calls.filter(([method]) => method === "cancelQuery"),
      [["cancelQuery", "q-1"]],
    );
    fail(new QueryCancelledError("The query was cancelled.", "postgres"));
  });

  it("answers a provider error's SQLSTATE in data", async () => {
    const missing = new QueryError('relation "t" does not exist', "postgres");
    missing.sqlstate = "42P01";
    const { handlers } = await openedOn(
      fakeProvider({
        query: async () => {
          throw missing;
        },
      }),
    );
    await assert.rejects(handlers.runQuery(RUN, idle), (error) => {
      assert.ok(error instanceof ResponseError);
      assert.equal((error.data as BackendErrorData).sqlState, "42P01");
      return true;
    });
  });

  it("query/run opens its provider under the run's own open wait, and a token cancelled while it opens answers QUERY_CANCELLED not-sent", async () => {
    const { handlers, factory, provider } = await openedOn();
    const waits: { signal: AbortSignal }[] = [];
    let reached: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      reached = resolve;
    });
    factory.getOrCreateProvider = async (...args) => {
      const wait = args[3] as { signal: AbortSignal };
      waits.push(wait);
      reached();
      // An open that never connects: only the run's own wait ends it, as the factory's open table ends a caller's wait.
      return new Promise<never>((_resolve, reject) => {
        wait.signal.addEventListener("abort", () => reject(wait.signal.reason), { once: true });
      });
    };
    const source = new CancellationTokenSource();
    const run = handlers.runQuery(RUN, source.token);
    await opening;
    assert.equal(waits[0]?.signal.aborted, false);
    source.cancel();

    const notSent = Object.assign(new QueryCancelledError("The query was cancelled.", "postgres"), {
      outcome: "not-sent" as const,
    });
    await answeredAs(run, notSent);
    assert.equal(waits[0]?.signal.aborted, true);
    assert.deepEqual(methodsOf(provider), []);
  });

  it("starts nothing for a request already cancelled", async () => {
    const { handlers, provider } = await openedOn();
    const source = new CancellationTokenSource();
    source.cancel();
    // Refused before any call, so nothing reached the database.
    const notSent = Object.assign(new QueryCancelledError("The query was cancelled.", "postgres"), {
      outcome: "not-sent" as const,
    });
    await answeredAs(handlers.runQuery(RUN, source.token), notSent);
    assert.equal(methodsOf(provider).includes("query"), false);
  });

  it("logs a cancel the engine refused under the run's route", async () => {
    const refusedCancel = new Error("cancel refused");
    let finish: (result: QueryResult) => void = () => {};
    const provider = fakeProvider({
      cancelQuery: async () => {
        throw refusedCancel;
      },
      query: () => new Promise<QueryResult>((resolve) => (finish = resolve)),
    });
    const { handlers } = await openedOn(provider);
    const source = new CancellationTokenSource();
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const run = handlers.runQuery(RUN, source.token);
      await settled();
      source.cancel();
      await answeredAs(run, new QueryCancelledError("The query was cancelled."));
      await settled();
      finish(resultOf(rowsOf(1)));
      await settled();
    } finally {
      console.warn = warn;
    }
    assert.equal(RUN_ROUTE, "vscode/query/run");
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /\{route=vscode\/query\/run, kind=internal, code=INTERNAL_ERROR\} The cancel sent after the request was aborted failed$/,
    );
  });
});

describe("the confirmation gate on query/run (FND-5 6e)", () => {
  composeHostCore();

  restoresRunConfirmationMode();
  const WRITE = "DELETE FROM t";
  const write = { ...RUN, statement: WRITE };

  /** The token query/target mints for `statement` on `connectionId`, read off its offer. */
  async function tokenFor(
    handlers: BackendHandlers,
    statement: string,
    connectionId = "c1",
    catalog?: string,
  ): Promise<string> {
    const answer = await handlers.runTarget({
      connectionId,
      text: statement,
      selection: { start: 0, end: 0 },
      cursor: 0,
      ...(catalog !== undefined && { catalog }),
    });
    assert.ok(answer.confirmation !== null, "expected an offer");
    return answer.confirmation.token;
  }

  /** Whether the provider was asked to run anything. */
  const ran = (provider: FakeProvider) => methodsOf(provider).includes("query");

  /** The 428's data: its code and its offer. */
  async function asked(call: Promise<unknown>, message = CONFIRMATION_REQUIRED_MESSAGE) {
    let data: BackendErrorData | undefined;
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof ResponseError);
      assert.equal(error.code, 428);
      assert.equal(error.message, message);
      data = error.data as BackendErrorData;
      return true;
    });
    assert.ok(data !== undefined);
    assert.equal(data.code, "CONFIRMATION_REQUIRED");
    assert.ok(data.confirmation !== undefined);
    assert.equal(typeof data.confirmation.token, "string");
    return data.confirmation;
  }

  const invalid = (call: Promise<unknown>, reason: string) =>
    refused(call, 400, reason, { code: "CONFIRMATION_INVALID" });

  it("answers a write sent with ask 428 with a token, and asks the provider to run nothing", async () => {
    const { handlers, provider, calls } = await openedOn();
    const before = calls.length;
    const offer = await asked(handlers.runQuery({ ...write, confirmation: "ask" }, idle));
    assert.deepEqual({ ...offer, token: "<token>", expiresAt: "<expiry>" }, ASKED);
    assert.equal(calls.length, before, "no provider is built for a request the gate answers");
    assert.deepEqual(provider.calls, []);
  });

  it("runs a write sent with no field in advisory, marked unconfirmed with one warning, and asks in required", async () => {
    const { handlers, provider } = await openedOn();
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
    let page: QueryPage;
    try {
      page = await handlers.runQuery(write, idle);
    } finally {
      console.warn = warn;
    }
    assert.equal(page.confirmation, "unconfirmed");
    assert.equal(ran(provider), true);
    assert.equal(RUN_CONFIRMATION_USER, "vscode-extension");
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /\{route=vscode\/query\/run, type=postgres, user=vscode-extension\} A statement that needs a confirmation ran without one$/,
    );
    assert.equal("confirmation" in (await handlers.runQuery(RUN, idle)), false, "a read is not marked");

    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    provider.calls.length = 0;
    await asked(handlers.runQuery(write, idle));
    assert.equal(ran(provider), false);
  });

  it("runs a write once with the token query/target minted for it, and refuses the same token again", async () => {
    const { handlers, provider } = await openedOn();
    const token = await tokenFor(handlers, WRITE);
    const page = await handlers.runQuery({ ...write, confirmation: { token } }, idle);
    assert.equal("confirmation" in page, false);
    assert.equal(methodsOf(provider).filter((method) => method === "query").length, 1);
    await invalid(
      handlers.runQuery({ ...write, confirmation: { token } }, idle),
      "this confirmation has already been used",
    );
    assert.equal(methodsOf(provider).filter((method) => method === "query").length, 1);
  });

  it("refuses a token another child, another statement, another connection or another catalog was minted for, and a fabricated one", async () => {
    const { handlers, provider } = await openedOn(
      fakeProvider({ getCapabilities: () => ({ ...SQL_CAPS, catalogSessions: true }) as ProviderCapabilities }),
    );
    await handlers.openConnection({ connection: { ...WIRE, id: "c2", host: "db2.internal" }, posture: POSTURE });
    provider.calls.length = 0;

    const other = await openedOn();
    const fromAnotherChild = await tokenFor(other.handlers, WRITE);
    await invalid(
      handlers.runQuery({ ...write, confirmation: { token: fromAnotherChild } }, idle),
      "this confirmation could not be verified",
    );

    const forAnotherStatement = await tokenFor(handlers, "DELETE FROM u");
    await invalid(
      handlers.runQuery({ ...write, confirmation: { token: forAnotherStatement } }, idle),
      "this confirmation was issued for another statement",
    );

    const onAnotherConnection = await tokenFor(handlers, WRITE, "c2");
    await invalid(
      handlers.runQuery({ ...write, confirmation: { token: onAnotherConnection } }, idle),
      "this confirmation was issued for another connection",
    );

    const inAnotherCatalog = await tokenFor(handlers, WRITE, "c1", "sales");
    await invalid(
      handlers.runQuery({ ...write, catalog: "billing", confirmation: { token: inAnotherCatalog } }, idle),
      "this confirmation was issued for another connection",
    );

    await invalid(
      handlers.runQuery({ ...write, confirmation: { token: crypto.randomUUID() } }, idle),
      "this confirmation could not be verified",
    );
    assert.equal(ran(provider), false);
  });

  it("asks for a production connection's name whatever the request sends, and runs only with it", async () => {
    const name = crypto.randomUUID();
    const { handlers, provider } = await openedOn(fakeProvider(), { ...WIRE, name, environment: "production" });
    const typedAsk = { type: "connection-name", expected: name, targets: [] };
    for (const mode of ["advisory", "required"]) {
      process.env.LIBREDB_RUN_CONFIRMATION = mode;
      for (const confirmation of ["ask", undefined]) {
        // oxlint-disable-next-line no-await-in-loop -- each mode is set in the environment before its run.
        const offer = await asked(handlers.runQuery({ ...write, confirmation }, idle), CONFIRMATION_TYPED_MESSAGE);
        assert.deepEqual(offer.typedConfirmation, typedAsk);
      }
    }
    delete process.env.LIBREDB_RUN_CONFIRMATION;
    const token = await tokenFor(handlers, WRITE);
    const again = await asked(
      handlers.runQuery({ ...write, confirmation: { token } }, idle),
      CONFIRMATION_TYPED_MESSAGE,
    );
    assert.notEqual(again.token, token);
    await invalid(
      handlers.runQuery({ ...write, confirmation: { token, typed: crypto.randomUUID() } }, idle),
      "the typed confirmation does not match what this statement asks to be typed",
    );
    assert.equal(ran(provider), false);
    // The first token was spent by neither refusal.
    await handlers.runQuery({ ...write, confirmation: { token, typed: name } }, idle);
    assert.equal(methodsOf(provider).filter((method) => method === "query").length, 1);
    await handlers.runQuery({ ...RUN, confirmation: "ask" }, idle);
    assert.equal(methodsOf(provider).filter((method) => method === "query").length, 2);
  });

  it("classifies a page read like any run", async () => {
    const { handlers, provider } = await openedOn();
    await asked(handlers.runQuery({ ...write, offset: 2, confirmation: "ask" }, idle));
    assert.equal(ran(provider), false);
  });

  it("refuses a malformed field with the route's sentence and no data, and runs nothing", async () => {
    const { handlers, provider } = await openedOn();
    for (const confirmation of [{ token: 1 }, "yes"]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is checked on its own.
      await refused(handlers.runQuery({ ...RUN, confirmation }, idle), 400, CONFIRMATION_FIELD_MESSAGE);
    }
    assert.equal(ran(provider), false);
  });

  it("refuses an unreadable run confirmation setting by name, and runs nothing", async () => {
    const { handlers, provider } = await openedOn();
    process.env.LIBREDB_RUN_CONFIRMATION = "strict";
    await assert.rejects(
      handlers.runQuery(RUN, idle),
      (error) => error instanceof DatabaseConfigError && error.message === INVALID_RUN_CONFIRMATION_SETTING,
    );
    assert.equal(ran(provider), false);
  });

  it("keeps a refusal of the bounds or the text bound whatever confirmation holds", async () => {
    const { handlers, calls } = backend();
    await handlers.openConnection({ connection: WIRE, posture: POSTURE });
    await handlers.openConnection({ connection: { ...WIRE, id: "c2", type: "influxdb" }, posture: POSTURE });
    const before = calls.length;
    await refused(
      handlers.runQuery({ ...write, limit: -1, confirmation: "yes" }, idle),
      -32602,
      "options.limit must be a non-negative integer",
    );
    const bound = consoleTextByteLimit("influxdb");
    assert.ok(bound !== undefined);
    const text = "x".repeat(bound + 1);
    const sentence = consoleTextOverLimit(text, bound);
    assert.ok(sentence !== undefined);
    await refused(
      handlers.runQuery({ ...RUN, connectionId: "c2", statement: text, confirmation: { token: 1 } }, idle),
      413,
      sentence,
      { code: "TEXT_TOO_LARGE" },
    );
    assert.equal(calls.length, before);
  });
});

describe("objects/selectStatement", () => {
  const ORDERS = { path: ["public", "orders"], name: "orders", kind: "table" };
  const COLUMNS: ColumnSchema[] = [
    { name: "id", type: "integer", nullable: false, isPrimary: true },
    { name: "Total", type: "numeric", nullable: true, isPrimary: false },
  ];
  /** SQL_CAPS with a projection that reads every column as it is, so the statement names the described columns. */
  const PROJECTED = {
    ...SQL_CAPS,
    previewProjection: { rules: [], omittedNote: "", unprojectedNote: "No columns." },
  } as ProviderCapabilities;
  /** A JSON-language engine with one container level, the database, as MongoDB declares it. */
  const JSON_CAPS = {
    queryLanguage: "json",
    containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
    objectKinds: [{ id: "collection", role: "relation", label: "Collection", labelPlural: "Collections" }],
  } as unknown as ProviderCapabilities;

  const on = (capabilities: ProviderCapabilities, over: ProviderSurface = {}) =>
    openedOn(fakeProvider({ getCapabilities: () => capabilities, ...over }));

  it("answers the generator's statement and describes nothing where no previewProjection is declared", async () => {
    const { handlers, provider } = await on(SQL_CAPS, { describeObject: async () => ({}) as ObjectDetail });
    // The PostgreSQL rule quotes only a name outside the lowercase bare set.
    assert.deepEqual(await handlers.selectStatement({ connectionId: "c1", object: ORDERS }), {
      statement: "SELECT * FROM public.orders;",
    });
    assert.deepEqual(methodsOf(provider), ["getCapabilities"]);
  });

  it("answers the statement in its provider's type's quoting, never the port its declaration names", async () => {
    // SQL_CAPS declares PostgreSQL's port; only the provider's type can write MySQL's backticks.
    const { handlers } = await openedOn(fakeProvider({ type: "mysql", getCapabilities: () => SQL_CAPS }));
    const object = { path: ["app", "Order Items"], name: "Order Items", kind: "table" };
    assert.deepEqual(await handlers.selectStatement({ connectionId: "c1", object }), {
      statement: "SELECT * FROM app.`Order Items`;",
    });
  });

  it("names the described columns where a previewProjection is declared on a kind with columns", async () => {
    const detail = { path: ORDERS.path, columns: COLUMNS, indexes: [], foreignKeys: [] };
    const { handlers, provider } = await on(PROJECTED, { describeObject: async () => detail });
    assert.deepEqual(await handlers.selectStatement({ connectionId: "c1", object: ORDERS }), {
      statement: 'SELECT id, "Total" FROM public.orders;',
    });
    assert.deepEqual(
      provider.calls.filter(([method]) => method === "describeObject"),
      [["describeObject", ["public", "orders"], "table"]],
    );
  });

  it("answers a JSON command addressed by the declared levels", async () => {
    const { handlers } = await on(JSON_CAPS);
    const object = { path: ["shop", "orders"], name: "orders", kind: "collection" };
    const expected = { database: "shop", collection: "orders", operation: "find", filter: {}, options: { limit: 50 } };
    assert.deepEqual(await handlers.selectStatement({ connectionId: "c1", object }), {
      statement: JSON.stringify(expected, null, 2),
    });
  });

  it("answers the generator's own sentence as INTERNAL_ERROR when it refuses the path", async () => {
    const { handlers } = await on(JSON_CAPS);
    const object = { path: ["orders"], name: "orders", kind: "collection" };
    let sentence = "";
    try {
      generateTableQuery(object.path, "mongodb", JSON_CAPS);
    } catch (error) {
      sentence = (error as Error).message;
    }
    assert.notEqual(sentence, "");
    await refused(handlers.selectStatement({ connectionId: "c1", object }), 500, sentence, { code: "INTERNAL_ERROR" });
  });

  it("refuses an object it cannot read, naming the field, before resolving a provider", async () => {
    const { handlers, calls } = await on(SQL_CAPS);
    const before = calls.length;
    const cases: [unknown, string][] = [
      ["orders", "object must be an object"],
      [{ path: "public.orders", kind: "table", name: "orders" }, "object.path must be an array of strings"],
      [{ path: [], kind: 5, name: "x" }, "object.kind must be a string"],
      [{ path: [], kind: "table" }, "object.name must be a string"],
    ];
    await Promise.all(
      cases.map(([object, message]) =>
        refused(handlers.selectStatement({ connectionId: "c1", object }), -32602, message),
      ),
    );
    await refused(handlers.selectStatement({ object: ORDERS }), -32602, "connectionId must be a non-empty string");
    assert.equal(calls.length, before);
  });

  it("refuses a connection this backend has not opened", async () => {
    const { handlers } = await on(SQL_CAPS);
    await refused(
      handlers.selectStatement({ connectionId: "c9", object: ORDERS }),
      404,
      'No connection with id "c9" is open in this LibreDB backend.',
      { code: "CONNECTION_NOT_OPEN" },
    );
  });
});

describe("query/target", () => {
  restoresRunConfirmationMode();
  const TEXT = "select 1;\nselect 2;";
  const NONE = { start: 0, end: 0 };
  const target = (handlers: BackendHandlers, text: string, cursor: number, selection: unknown = NONE) =>
    handlers.runTarget({ connectionId: "c1", text, selection, cursor });
  const on = (capabilities: ProviderCapabilities = SQL_CAPS) =>
    openedOn(fakeProvider({ getCapabilities: () => capabilities }));

  /** The RangeError runTarget itself throws for these offsets, so the test holds its sentence, not a copy. */
  function rangeSentence(text: string, selection: { start: number; end: number }, cursor: number): string {
    const rule = {
      editorLanguage: "sql" as const,
      statementTerminator: undefined,
      grammar: resolveSqlGrammar("postgres"),
    };
    try {
      runTarget({ text, selection, cursor, ...rule });
    } catch (error) {
      assert.ok(error instanceof RangeError);
      return error.message;
    }
    assert.fail("runTarget accepted the offsets");
  }

  it("answers the cursor's statement, without its terminator, and where it sits", async () => {
    const { handlers } = await on();
    const first = { statement: "select 1", range: { start: 0, end: 8 }, confirmation: null };
    const second = { statement: "select 2", range: { start: 10, end: 18 }, confirmation: null };
    assert.deepEqual(await target(handlers, TEXT, 3), first);
    // At the end of the first statement, and on the newline after its terminator, the first is the one before.
    assert.deepEqual(await target(handlers, TEXT, 8), first);
    assert.deepEqual(await target(handlers, TEXT, 9), first);
    // Offset 10 is where the second statement starts.
    assert.deepEqual(await target(handlers, TEXT, 10), second);
    assert.deepEqual(await target(handlers, TEXT, 19), second);
  });

  it("answers a non-blank selection as written, and falls back to the cursor on a blank one", async () => {
    const { handlers } = await on();
    assert.deepEqual(await target(handlers, TEXT, 0, { start: 10, end: 18 }), {
      statement: "select 2",
      range: { start: 10, end: 18 },
      confirmation: null,
    });
    const spaced = "select 1;\n   \nselect 2;";
    assert.deepEqual(await target(handlers, spaced, 3, { start: 10, end: 13 }), {
      statement: "select 1",
      range: { start: 0, end: 8 },
      confirmation: null,
    });
  });

  it("answers an empty statement with no range for a text that holds no code", async () => {
    const { handlers } = await on();
    assert.deepEqual(await target(handlers, "-- only a note\n/* and this */", 0), {
      statement: "",
      confirmation: null,
    });
    assert.deepEqual(await target(handlers, "", 0), { statement: "", confirmation: null });
  });

  it("answers the whole text with no range in an editor language other than sql, whatever the cursor", async () => {
    const { handlers } = await on({ ...SQL_CAPS, queryLanguage: "json" } as ProviderCapabilities);
    const text = '{ "collection": "orders" }';
    assert.deepEqual(await target(handlers, text, 0), { statement: text, confirmation: null });
    assert.deepEqual(await target(handlers, text, 12), { statement: text, confirmation: null });
  });

  it("offers a confirmation for a target the gate asks about, and only that one", async () => {
    const { handlers } = await on();
    const text = "select 1;\ndelete from t;";
    assert.deepEqual(await target(handlers, text, 3), {
      statement: "select 1",
      range: { start: 0, end: 8 },
      confirmation: null,
    });
    assert.deepEqual(shaped(await target(handlers, text, 12)), {
      statement: "delete from t",
      range: { start: 10, end: 23 },
      confirmation: ASKED,
    });
  });

  it("offers a confirmation for a selection that holds a write behind a read, which the gate splits as the runner does", async () => {
    const { handlers } = await on();
    assert.deepEqual(shaped(await target(handlers, "select 1; drop table t", 0, { start: 0, end: 22 })), {
      statement: "select 1; drop table t",
      range: { start: 0, end: 22 },
      confirmation: ASKED,
    });
  });

  it("offers an unreadable run as unreadable", async () => {
    const { handlers } = await on();
    const text = "SELECT E'\\'; DELETE FROM t";
    const answer = shaped(await target(handlers, text, 0, { start: 0, end: text.length }));
    assert.deepEqual(answer.confirmation, { ...ASKED, unreadable: true });
  });

  it("asks for a production connection's name on a write, and nothing on a read", async () => {
    const name = crypto.randomUUID();
    const { handlers } = await openedOn(fakeProvider({ getCapabilities: () => SQL_CAPS }), {
      ...WIRE,
      name,
      environment: "production",
    });
    assert.deepEqual(shaped(await target(handlers, "DELETE FROM t", 0)).confirmation, {
      ...ASKED,
      typedConfirmation: { type: "connection-name", expected: name, targets: [] },
    });
    assert.equal((await target(handlers, "SELECT 1", 0)).confirmation, null);
  });

  it("asks for the row's text on an etcd lease revoke off production", async () => {
    const lease = "694d77aa9e38260f";
    const etcd = await openedOn(
      fakeProvider({ getCapabilities: () => ({ ...SQL_CAPS, queryLanguage: "json" }) as ProviderCapabilities }),
      { ...WIRE, type: "etcd", environment: "development" },
    );
    const revoke = `lease revoke ${lease}`;
    assert.deepEqual(shaped(await target(etcd.handlers, revoke, 0)).confirmation, {
      ...ASKED,
      typedConfirmation: { type: "text", expected: lease },
    });
  });

  it("refuses a write on a nameless production connection with the route's sentence and no data", async () => {
    const { handlers } = await openedOn(fakeProvider({ getCapabilities: () => SQL_CAPS }), {
      ...WIRE,
      name: "",
      environment: "production",
    });
    await refused(target(handlers, "DELETE FROM t", 0), 400, TYPED_NAME_MISSING_REFUSAL);
  });

  it("refuses a catalog that is present and not a non-empty string", async () => {
    const { handlers } = await on();
    for (const catalog of ["", 3]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is checked on its own.
      await refused(
        handlers.runTarget({ connectionId: "c1", text: TEXT, selection: NONE, cursor: 0, catalog }),
        -32602,
        "catalog must be a non-empty string",
      );
    }
  });

  it("refuses an unreadable run confirmation setting by name", async () => {
    const { handlers } = await on();
    process.env.LIBREDB_RUN_CONFIRMATION = "strict";
    await assert.rejects(
      target(handlers, "select 1", 0),
      (error) => error instanceof DatabaseConfigError && error.message === INVALID_RUN_CONFIRMATION_SETTING,
    );
  });

  it("reads the target under the connection's type", async () => {
    // A `#` starts a comment in MySQL and is code in PostgreSQL, so only there does the DELETE after it run.
    const text = "select 1 # ; delete from t";
    const whole = { start: 0, end: text.length };
    const postgres = await on();
    const mysql = await openedOn(fakeProvider({ getCapabilities: () => SQL_CAPS }), { ...WIRE, type: "mysql" });
    assert.notEqual((await target(postgres.handlers, text, 0, whole)).confirmation, null);
    assert.equal((await target(mysql.handlers, text, 0, whole)).confirmation, null);
  });

  it("reads an EXPLAIN chain as long as the analyze route's bound without running out of stack", async function () {
    // Each EXPLAIN ANALYZE executes the statement after it, so the gate reads 62,500 of them to reach the last
    // statement. Read one call deeper per EXPLAIN, Node's stack ended the read with a RangeError a few thousand in.
    // Two million-unit texts under c8 take about 1.2 s locally and went past mocha's 2 s default on a CI runner; the
    // gate's growth is pinned by tests/unit/sql/dangerous-query.test.ts, so this one only needs room to finish.
    this.timeout(30_000);
    const { handlers } = await on();
    const write = `${"EXPLAIN ANALYZE ".repeat(62_500)}DELETE FROM t`;
    const read = `${"EXPLAIN ANALYZE ".repeat(62_500)}SELECT 1`;
    assert.notEqual((await target(handlers, write, 0, { start: 0, end: write.length })).confirmation, null);
    assert.equal((await target(handlers, read, 0, { start: 0, end: read.length })).confirmation, null);
  });

  it("offers a confirmation for a non-SQL target by its engine's own vocabulary", async () => {
    const mongo = await openedOn(
      fakeProvider({ getCapabilities: () => ({ ...SQL_CAPS, queryLanguage: "json" }) as ProviderCapabilities }),
      { ...WIRE, type: "mongodb" },
    );
    const drop = '{ "collection": "orders", "operation": "deleteMany", "filter": {} }';
    assert.deepEqual(shaped(await target(mongo.handlers, drop, 0)), { statement: drop, confirmation: ASKED });
    const find = '{ "collection": "orders", "operation": "find" }';
    assert.deepEqual(await target(mongo.handlers, find, 0), { statement: find, confirmation: null });
  });

  it("offers a confirmation for a statement a row's claim would spare when Studio's review record does not list the claim", async () => {
    // A row that decides alone is the gate's whole answer only where the record lists its claim
    // (`CONFIRMATION_CLAIM_REVIEW`); this one is planted under trino, whose text is SQL, so the DROP is read as SQL.
    const table = NON_SQL_DESTRUCTIVE_VOCABULARY as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(table, "trino"), false);
    table.trino = { operations: new Set<string>(), read: () => [], decidesAlone: true };
    try {
      const trino = await openedOn(fakeProvider({ getCapabilities: () => SQL_CAPS }), { ...WIRE, type: "trino" });
      const drop = "DROP TABLE t";
      assert.deepEqual(shaped(await target(trino.handlers, drop, 0)), {
        statement: drop,
        range: { start: 0, end: drop.length },
        confirmation: ASKED,
      });
    } finally {
      delete table.trino;
    }
  });

  it("reads a listed exempt form as exempt", async () => {
    const snowflake = await openedOn(fakeProvider({ getCapabilities: () => SQL_CAPS }), { ...WIRE, type: "snowflake" });
    const session = "ALTER SESSION SET QUERY_TAG = 'x'";
    assert.equal((await target(snowflake.handlers, session, 0)).confirmation, null);
  });

  it("answers runTarget's RangeError as InvalidParams with its sentence", async () => {
    const { handlers } = await on();
    const offsets = [
      [{ start: 5, end: 2 }, 0],
      [{ start: 0, end: 99 }, 0],
      [NONE, 99],
    ] as const;
    await Promise.all(
      offsets.map(([selection, cursor]) =>
        refused(target(handlers, TEXT, cursor, selection), -32602, rangeSentence(TEXT, selection, cursor)),
      ),
    );
  });

  it("refuses params it cannot read, naming the field, before resolving a provider", async () => {
    const { handlers, calls } = await on();
    const before = calls.length;
    await refused(target(handlers, TEXT, 0, { start: 0.5, end: 1 }), -32602, "selection.start must be an integer");
    await refused(target(handlers, TEXT, 0, { start: 0, end: "1" }), -32602, "selection.end must be an integer");
    await refused(target(handlers, TEXT, 0, "0,1"), -32602, "selection must be an object");
    await refused(
      handlers.runTarget({ connectionId: "c1", text: TEXT, selection: NONE, cursor: "3" }),
      -32602,
      "cursor must be an integer",
    );
    await refused(
      handlers.runTarget({ connectionId: "c1", text: 7, selection: NONE, cursor: 0 }),
      -32602,
      "text must be a string",
    );
    await refused(handlers.runTarget({ text: TEXT }), -32602, "connectionId must be a non-empty string");
    assert.equal(calls.length, before);
  });

  it("refuses a connection this backend has not opened", async () => {
    const { handlers } = await on();
    await refused(
      handlers.runTarget({ connectionId: "c9", text: TEXT, selection: NONE, cursor: 0 }),
      404,
      'No connection with id "c9" is open in this LibreDB backend.',
      { code: "CONNECTION_NOT_OPEN" },
    );
  });

  it("answers a provider's error as toResponseError answers it with the connection's scrub", async () => {
    const broken = new Error("capabilities unreadable");
    const { handlers, provider } = await on();
    (provider as unknown as { getCapabilities: () => never }).getCapabilities = () => {
      throw broken;
    };
    await answeredAs(target(handlers, TEXT, 0), broken);
  });
});

describe("query/cancel", () => {
  composeHostCore();

  it("answers whether the engine stopped the statement", async () => {
    let stopped = true;
    const provider = fakeProvider({ cancelQuery: async () => stopped });
    const { handlers } = await openedOn(provider);
    assert.deepEqual(await handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, idle), { cancelled: true });
    assert.deepEqual(provider.calls.at(-1), ["cancelQuery", "q-7"]);
    stopped = false;
    assert.deepEqual(await handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, idle), { cancelled: false });
  });

  it("cancelQuery reaches the provider through the host's cancel call", async () => {
    const provider = fakeProvider({ cancelQuery: async (id: string) => id === "q-7" });
    const { handlers } = await openedOn(provider);
    const source = readFileSync(path.join(__dirname, "..", "..", "src", "backend", "handlers.ts"), "utf8");

    assert.deepEqual(await handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, idle), { cancelled: true });
    assert.deepEqual(await handlers.cancelQuery({ connectionId: "c1", queryId: "q-8" }, idle), { cancelled: false });
    assert.deepEqual(
      provider.calls.filter(([method]) => method === "cancelQuery"),
      [
        ["cancelQuery", "q-7"],
        ["cancelQuery", "q-8"],
      ],
    );
    assert.match(source, /await cancelEditorRun\(provider, queryId, /);
    assert.doesNotMatch(source, /provider\.cancelQuery\(/);
  });

  it("refuses a provider that cannot cancel (CANCEL_UNSUPPORTED)", async () => {
    const { handlers } = await openedOn();
    await refused(
      handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, idle),
      400,
      "Query cancellation is not supported for this database type",
      { code: "CANCEL_UNSUPPORTED" },
    );
  });

  it("cancels on the whole connection's provider, never a catalog's", async () => {
    const server = fakeProvider({
      getCapabilities: () => ({ ...CAPS, catalogSessions: true }),
      forCatalog: async () => fakeProvider(),
      cancelQuery: async () => true,
    });
    const { handlers, calls } = await openedOn(server);
    await handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, idle);
    assert.deepEqual(server.calls, [["cancelQuery", "q-7"]]);
    const [method, connection, options, posture, wait] = calls.at(-1) as unknown[];
    assert.deepEqual(
      [method, connection, options, posture],
      ["getOrCreateProvider", REVIVED, {}, { allowExternalFileAccess: true }],
    );
    assert.ok((wait as { signal: unknown }).signal instanceof AbortSignal);
  });

  it("refuses a connection this backend has not opened, and params it cannot read", async () => {
    const { handlers } = await openedOn();
    await refused(
      handlers.cancelQuery({ connectionId: "c9", queryId: "q-7" }, idle),
      404,
      'No connection with id "c9" is open in this LibreDB backend.',
      { code: "CONNECTION_NOT_OPEN" },
    );
    await refused(handlers.cancelQuery({ connectionId: "c1" }, idle), -32602, "queryId must be a non-empty string");
    await refused(handlers.cancelQuery({ queryId: "q-7" }, idle), -32602, "connectionId must be a non-empty string");
  });

  it("query/cancel takes its request's cancellation as its caller signal, while the provider opens and while the engine answers", async () => {
    const notSent = Object.assign(new QueryCancelledError("The query was cancelled.", "postgres"), {
      outcome: "not-sent" as const,
    });

    // While the provider opens: the cancel stops waiting, answers not-sent and calls no cancel.
    const opening = await openedOn(fakeProvider({ cancelQuery: async () => true }));
    let reached: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      reached = resolve;
    });
    opening.factory.getOrCreateProvider = async (...args) => {
      const wait = args[3] as { signal: AbortSignal };
      reached();
      return new Promise<never>((_resolve, reject) => {
        wait.signal.addEventListener("abort", () => reject(wait.signal.reason), { once: true });
      });
    };
    const whileOpening = new CancellationTokenSource();
    const leftOpening = opening.handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, whileOpening.token);
    await opened;
    whileOpening.cancel();
    await answeredAs(leftOpening, notSent);
    assert.deepEqual(opening.provider.calls, []);

    // While the engine answers: the cancel stops waiting at once, and the late answer is not logged as a failure.
    let answer: (stopped: boolean) => void = () => {};
    const provider = fakeProvider({ cancelQuery: () => new Promise<boolean>((resolve) => (answer = resolve)) });
    const { handlers } = await openedOn(provider);
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const whileAnswering = new CancellationTokenSource();
      const leftAnswering = handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, whileAnswering.token);
      await settled();
      assert.deepEqual(provider.calls, [["cancelQuery", "q-7"]]);
      whileAnswering.cancel();
      await answeredAs(leftAnswering, new QueryCancelledError("The query was cancelled."));
      answer(true);
      await settled();
      assert.deepEqual(lines, []);
    } finally {
      console.warn = warn;
    }
  });

  it("query/cancel with a token already cancelled calls nothing", async () => {
    const provider = fakeProvider({ cancelQuery: async () => true });
    const { handlers } = await openedOn(provider);
    const source = new CancellationTokenSource();
    source.cancel();
    const notSent = Object.assign(new QueryCancelledError("The query was cancelled.", "postgres"), {
      outcome: "not-sent" as const,
    });

    await answeredAs(handlers.cancelQuery({ connectionId: "c1", queryId: "q-7" }, source.token), notSent);
    assert.deepEqual(provider.calls, []);
  });
});

describe("engines/list", () => {
  it("answers the catalogue of the enabled types and constructs no provider", () => {
    const { handlers, calls } = backend();
    assert.deepEqual(handlers.listEngines({}), engineCatalog(["postgres", "mssql", "mysql", "mongodb"]));
    assert.deepEqual(calls, []);
  });

  it("answers every external type when no list is set", () => {
    const { handlers } = backend(fakeProvider(), { enabledProviderTypes: () => null });
    assert.deepEqual(handlers.listEngines({}), engineCatalog(null));
  });

  it("refuses params that are not an empty object", () => {
    const { handlers } = backend();
    for (const params of [{ a: 1 }, null, [], undefined]) {
      refusedNow(() => handlers.listEngines(params), -32602, "engines/list takes an empty params object");
    }
  });
});

describe("connection/parse", () => {
  it("refuses a text that is not a string, before parsing anything", () => {
    const { handlers, calls } = backend();
    refusedNow(() => handlers.parsePastedConnection({ text: 5 }), -32602, "text must be a string");
    refusedNow(() => handlers.parsePastedConnection({}), -32602, "text must be a string");
    assert.deepEqual(calls, []);
  });
});

/** host speaks to child over two in-memory streams, as the IPC channel carries the same messages. */
function pair() {
  const up = new PassThrough();
  const down = new PassThrough();
  const host = createMessageConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
  const child = createMessageConnection(new StreamMessageReader(up), new StreamMessageWriter(down));
  return { host, child };
}

/** An error answer as the host reads it. */
interface Answered {
  code: number;
  message: string;
  data?: BackendErrorData;
}

/** The error a request was answered with; fails when it was answered with a result. */
async function answeredError(host: MessageConnection, method: string, params?: object): Promise<Answered> {
  const outcome = await host.sendRequest(method, params).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  assert.ok("error" in outcome, `expected an error answer, got ${JSON.stringify(outcome)}`);
  assert.ok(outcome.error instanceof ResponseError);
  const { code, message, data } = outcome.error;
  return { code, message, ...(data !== undefined && { data }) };
}

describe("toResponseError", () => {
  it("passes a ResponseError on as the same object", () => {
    const params = invalidParams("connectionId must be a non-empty string");
    assert.equal(toResponseError(params), params);
  });

  it("puts only the defined ones of retryable, details and fixStatement beside a database error's code", () => {
    const bare = toResponseError(new QueryError("syntax error", "postgres"));
    assert.deepEqual(Object.keys(bare.data ?? {}), ["code", "kind", "outcome"]);
    const timeout = toResponseError(new TimeoutError("Query timeout after 60000ms", "postgres", 60000));
    assert.deepEqual(timeout.data, { code: "TIMEOUT_ERROR", retryable: true, kind: "timeout", outcome: "unknown" });
  });

  it("puts a database error's kind and outcome beside its code", async () => {
    const lost = toResponseError(new ConnectionError("Connection terminated unexpectedly", "postgres"));
    assert.deepEqual(lost.data, {
      code: "CONNECTION_ERROR",
      retryable: true,
      kind: "connection",
      outcome: "unknown",
    });
    const failed = await connectPhase(() =>
      Promise.reject(new ConnectionError("connect ECONNREFUSED", "postgres")),
    ).catch((error: unknown) => error);
    assert.deepEqual(toResponseError(failed).data, {
      code: "CONNECTION_ERROR",
      retryable: true,
      kind: "connection",
      outcome: "not-sent",
    });
    assert.deepEqual(toResponseError(new RefusedBeforeSendError("refused before sending", "postgres")).data, {
      code: "QUERY_ERROR",
      kind: "refused-before-send",
      outcome: "not-sent",
    });
  });

  it("an internal error and the extension's own refusals carry no kind and no outcome", () => {
    for (const error of [
      toResponseError(new Error("boom")),
      toResponseError("boom"),
      toResponseError(refusal(404, "CONNECTION_NOT_OPEN", "not open")),
      toResponseError(refusal(413, "TEXT_TOO_LARGE", "too large")),
    ]) {
      const data = (error.data ?? {}) as object;
      assert.equal(Object.hasOwn(data, "kind"), false);
      assert.equal(Object.hasOwn(data, "outcome"), false);
    }
    assert.deepEqual(toResponseError(new Error("boom")).data, { code: "INTERNAL_ERROR" });
  });

  it("without a scrub no data carries a SQLSTATE", () => {
    const missing = new QueryError('relation "orders" does not exist', "postgres");
    missing.sqlstate = "42P01";
    assert.equal(Object.hasOwn(toResponseError(missing).data ?? {}, "sqlState"), false);
  });
});

describe("toResponseError with the connection's scrub", () => {
  const password = crypto.randomUUID();
  const scrub = providerTextScrub({ ...REVIVED, password }, "any");

  it("a withheld error keeps its status, code, kind, outcome and retryable, and its message is the withheld sentence", async () => {
    const failed = await connectPhase(() =>
      Promise.reject(new ConnectionError(`could not connect as ${password}`, "postgres")),
    ).catch((error: unknown) => error);
    const clean = await connectPhase(() => Promise.reject(new ConnectionError("could not connect", "postgres"))).catch(
      (error: unknown) => error,
    );
    const withheld = toResponseError(failed, scrub);
    const answered = toResponseError(clean, scrub);
    assert.equal(withheld.code, answered.code);
    assert.deepEqual(withheld.data, answered.data);
    assert.equal(withheld.message, withheldErrorMessage("ConnectionError"));

    const detailed = toResponseError(
      new QueryError("syntax error", "postgres", "SELECT 1", 4, `near ${password}`),
      scrub,
    );
    assert.equal(detailed.code, 400);
    assert.deepEqual(detailed.data, {
      code: "QUERY_ERROR",
      details: { position: 4 },
      kind: "query",
      outcome: "unknown",
    });
    const fix = toResponseError(
      new AuthenticationError("denied", "postgres", { fixStatement: `ALTER ROLE x PASSWORD '${password}'` }),
      scrub,
    );
    assert.equal(fix.code, 401);
    assert.deepEqual(fix.data, { code: "AUTH_ERROR", kind: "authentication", outcome: "unknown" });
    const plain = toResponseError(new Error(`boom ${password}`), scrub);
    assert.equal(plain.code, 500);
    assert.deepEqual(plain.data, { code: "INTERNAL_ERROR" });
    assert.equal(plain.message, withheldErrorMessage("Error"));
    for (const error of [withheld, detailed, fix, plain]) {
      assert.equal(JSON.stringify({ message: error.message, data: error.data }).includes(password), false);
    }
  });

  it("a database error's data carries the SQLSTATE its record carries, after its outcome", () => {
    const missing = new QueryError('relation "orders" does not exist', "postgres");
    missing.sqlstate = "42P01";
    const answered = toResponseError(missing, scrub);
    assert.equal(answered.code, 400);
    assert.deepEqual(answered.data, { code: "QUERY_ERROR", kind: "query", outcome: "unknown", sqlState: "42P01" });
    assert.deepEqual(Object.keys(answered.data ?? {}), ["code", "kind", "outcome", "sqlState"]);
  });

  it("a withheld error's data carries no SQLSTATE", () => {
    const missing = new QueryError(`relation "orders" does not exist for ${password}`, "postgres");
    missing.sqlstate = "42P01";
    const withheld = toResponseError(missing, scrub);
    assert.equal(withheld.message, withheldErrorMessage("QueryError"));
    assert.deepEqual(withheld.data, { code: "QUERY_ERROR", kind: "query", outcome: "unknown" });
  });

  it("an internal error and the extension's own refusals carry no SQLSTATE", () => {
    for (const error of [
      toResponseError(new Error("boom"), scrub),
      toResponseError("boom", scrub),
      toResponseError(refusal(404, "CONNECTION_NOT_OPEN", "not open"), scrub),
      toResponseError(refusal(413, "TEXT_TOO_LARGE", "too large"), scrub),
    ]) {
      assert.equal(Object.hasOwn(error.data ?? {}, "sqlState"), false);
    }
  });

  it("a clean error and a ResponseError pass unchanged", () => {
    const params = invalidParams("connectionId must be a non-empty string");
    assert.equal(toResponseError(params, scrub), params);
    const error = new QueryError("syntax error", "postgres", "SELECT 1", 4, "near SELEC");
    const scrubbed = toResponseError(error, scrub);
    const plain = toResponseError(error);
    assert.equal(scrubbed.code, plain.code);
    assert.equal(scrubbed.message, plain.message);
    assert.deepEqual(scrubbed.data, plain.data);
  });
});

describe("provider errors that hold the connection's credential", () => {
  composeHostCore();

  const password = crypto.randomUUID();
  const wire = { ...WIRE, password };

  /** Asserts the call answers a ResponseError that holds no form of the password, with the clean answer's status and code. */
  async function withheldAnswer(call: Promise<unknown>, clean: unknown): Promise<void> {
    const expected = toResponseError(clean);
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof ResponseError, "expected a ResponseError");
      assert.equal(error.code, expected.code);
      assert.equal((error.data as BackendErrorData).code, (expected.data as BackendErrorData).code);
      assert.equal(error.message, withheldErrorMessage((clean as Error).name));
      assert.equal(JSON.stringify({ message: error.message, data: error.data }).includes(password), false, "a field");
      return true;
    });
  }

  /** The handlers after an open of the password's record on `provider`. */
  async function openedHolding(over: ProviderSurface = {}) {
    const provider = fakeProvider(over);
    const made = backend(provider);
    await made.handlers.openConnection({ connection: wire, posture: POSTURE });
    return made;
  }

  it("connection/test answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = backend(fakeProvider(), {
      testConnection: async () => {
        throw new ConnectionError(`password authentication failed for ${password}`, "postgres");
      },
    });
    await withheldAnswer(
      handlers.testConnection({ connection: wire, posture: POSTURE }),
      new ConnectionError("password authentication failed", "postgres"),
    );
  });

  it("connection/open answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = backend(fakeProvider(), {
      getOrCreateProvider: async () => {
        throw new AuthenticationError(`password authentication failed for ${password}`, "postgres");
      },
    });
    await withheldAnswer(
      handlers.openConnection({ connection: wire, posture: POSTURE }),
      new AuthenticationError("password authentication failed", "postgres"),
    );
  });

  const held = () => new PermissionDeniedError(`permission denied for ${password}`, "postgres");
  const clean = new PermissionDeniedError("permission denied", "postgres");
  const reject = async () => {
    throw held();
  };

  it("objects/listContainers answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = await openedHolding({ listContainers: reject });
    await withheldAnswer(handlers.listContainers({ connectionId: "c1" }), clean);
  });

  it("objects/countObjects answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = await openedHolding({ countObjects: reject });
    await withheldAnswer(handlers.countObjects({ connectionId: "c1", container: ["app"] }), clean);
  });

  it("objects/listObjects answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = await openedHolding({ listObjects: reject });
    await withheldAnswer(handlers.listObjects({ connectionId: "c1", container: ["app"], kind: "table" }), clean);
  });

  it("objects/describeObject answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = await openedHolding({ describeObject: reject });
    await withheldAnswer(handlers.describeObject({ connectionId: "c1", path: ["app", "t"], kind: "table" }), clean);
  });

  it("query/run answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = await openedHolding({
      query: async () => {
        throw new QueryError(`syntax error near ${password}`, "postgres");
      },
    });
    await withheldAnswer(handlers.runQuery(RUN, idle), new QueryError("syntax error", "postgres"));
  });

  it("query/cancel answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers } = await openedHolding({ cancelQuery: reject });
    await withheldAnswer(handlers.cancelQuery({ connectionId: "c1", queryId: "q-1" }, idle), clean);
  });

  it("objects/selectStatement answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers, provider } = await openedHolding();
    (provider as unknown as { getCapabilities: () => never }).getCapabilities = () => {
      throw held();
    };
    await withheldAnswer(
      handlers.selectStatement({ connectionId: "c1", object: { path: ["app", "t"], kind: "table", name: "t" } }),
      clean,
    );
  });

  it("query/target answers a provider error that holds the connection's credential withheld, with its own status and code", async () => {
    const { handlers, provider } = await openedHolding();
    (provider as unknown as { getCapabilities: () => never }).getCapabilities = () => {
      throw held();
    };
    await withheldAnswer(
      handlers.runTarget({ connectionId: "c1", text: "select 1", selection: { start: 0, end: 0 }, cursor: 0 }),
      clean,
    );
  });

  it("query/run answers a warning that holds the credential withheld", async () => {
    const { handlers } = await openedHolding({
      query: async () =>
        resultOf(rowsOf(1), {
          warnings: [{ message: `a notice about ${password}`, code: "01000" }, { message: "a clean notice" }],
        }),
    });
    const answer = await handlers.runQuery(RUN, idle);
    assert.deepEqual(answer.warnings, [
      { message: PROVIDER_TEXT_WITHHELD, code: "01000" },
      { message: "a clean notice" },
    ]);
  });
});

describe("registerHandlers", () => {
  const open: MessageConnection[] = [];
  afterEach(() => {
    for (const connection of open.splice(0)) connection.dispose();
  });

  /** A host connected to the handlers registered on a child connection, both listening. */
  function served(over: Partial<BackendHandlers> = {}, made = fakeFactory()) {
    const { host, child } = pair();
    const exits: number[] = [];
    registerHandlers(child, { ...createHandlers(made.factory, RUNTIME), ...over }, (code) => exits.push(code));
    child.listen();
    host.listen();
    open.push(host, child);
    return { host, exits, calls: made.calls };
  }

  /** served, after an initialize the child answered. */
  async function initialized(over: Partial<BackendHandlers> = {}, made = fakeFactory()) {
    const session = served(over, made);
    await session.host.sendRequest(METHODS.initialize, { protocolVersion: 2 });
    return session;
  }

  it("registers one request handler under each METHODS name, and the exit notification", () => {
    const requests: string[] = [];
    const notifications: string[] = [];
    const connection = {
      onRequest: (method: string) => requests.push(method),
      onNotification: (method: string) => notifications.push(method),
    } as unknown as MessageConnection;
    registerHandlers(connection, createHandlers(fakeFactory().factory, RUNTIME), () => undefined);
    assert.deepEqual(requests, Object.values(METHODS));
    assert.ok(requests.includes("objects/selectStatement") && requests.includes("query/target"));
    assert.deepEqual(notifications, [EXIT_NOTIFICATION]);
  });

  it("refuses every request until an initialize has been answered, and serves them after it", async () => {
    const { host } = served();
    assert.deepEqual(await answeredError(host, METHODS.runQuery, RUN), {
      code: -32002,
      message: "The LibreDB backend has not been initialized.",
    });
    assert.equal((await answeredError(host, METHODS.initialize, { protocolVersion: 3 })).code, 500);
    assert.equal((await answeredError(host, METHODS.closeConnection, { connectionId: "c1" })).code, -32002);
    await host.sendRequest(METHODS.initialize, { protocolVersion: 2 });
    assert.equal(await host.sendRequest(METHODS.closeConnection, { connectionId: "c1" }), null);
  });

  it("refuses engines/list and connection/parse before initialize, and serves both after it", async () => {
    const { host, calls } = served();
    const notInitialized = { code: -32002, message: "The LibreDB backend has not been initialized." };
    assert.deepEqual(await answeredError(host, METHODS.listEngines, {}), notInitialized);
    assert.deepEqual(await answeredError(host, METHODS.parsePastedConnection, { text: "hello" }), notInitialized);
    await host.sendRequest(METHODS.initialize, { protocolVersion: 2 });
    assert.deepEqual(
      await host.sendRequest(METHODS.listEngines, {}),
      engineCatalog(["postgres", "mssql", "mysql", "mongodb"]),
    );
    assert.deepEqual(await host.sendRequest(METHODS.parsePastedConnection, { text: "hello" }), {
      parsed: null,
      label: null,
    });
    assert.deepEqual(await answeredError(host, METHODS.parsePastedConnection, { text: 5 }), {
      code: -32602,
      message: "text must be a string",
    });
    assert.deepEqual(calls, []);
  });

  it("answers each error class with the status, sentence and code the query route answers it with", async () => {
    const rows: [Error, number, string, BackendErrorData][] = [
      [
        new QueryCancelledError("The query was cancelled.", "postgres"),
        499,
        "The query was cancelled.",
        { code: "QUERY_CANCELLED", kind: "cancelled", outcome: "unknown" },
      ],
      [
        new QueryError('syntax error at or near "FORM"', "postgres", undefined, 10, "near FORM"),
        400,
        'syntax error at or near "FORM"',
        { code: "QUERY_ERROR", details: { position: 10, detail: "near FORM" }, kind: "query", outcome: "unknown" },
      ],
      [
        new QueryError("syntax error", "postgres"),
        400,
        "syntax error",
        { code: "QUERY_ERROR", kind: "query", outcome: "unknown" },
      ],
      [
        new DatabaseConfigError(
          "The sqlite provider is not available in this distribution of LibreDB Studio.",
          "sqlite",
        ),
        400,
        "The sqlite provider is not available in this distribution of LibreDB Studio.",
        { code: "CONFIG_ERROR", kind: "config", outcome: "unknown" },
      ],
      [
        new AuthenticationError('password authentication failed for user "app"', "postgres", {
          fixStatement: "ALTER ROLE app LOGIN;",
        }),
        401,
        'password authentication failed for user "app"',
        { code: "AUTH_ERROR", fixStatement: "ALTER ROLE app LOGIN;", kind: "authentication", outcome: "unknown" },
      ],
      [
        new PermissionDeniedError("permission denied for table orders", "postgres"),
        403,
        "permission denied for table orders",
        { code: "PERMISSION_DENIED", kind: "permission", outcome: "unknown" },
      ],
      [
        new TimeoutError("Query timeout after 60000ms", "postgres", 60000),
        504,
        TIMEOUT_SENTENCE,
        { code: "TIMEOUT_ERROR", retryable: true, kind: "timeout", outcome: "unknown" },
      ],
      [
        new ConnectionError("connect ECONNREFUSED 127.0.0.1:5432", "postgres"),
        503,
        "connect ECONNREFUSED 127.0.0.1:5432",
        { code: "CONNECTION_ERROR", retryable: true, kind: "connection", outcome: "unknown" },
      ],
      [
        new PoolExhaustedError("No connection is free in the pool", "postgres", 10),
        503,
        "No connection is free in the pool",
        { code: "POOL_EXHAUSTED", retryable: true, kind: "pool-exhausted", outcome: "unknown" },
      ],
      [
        new DatabaseError("The driver failed", "postgres"),
        500,
        "The driver failed",
        { code: "DATABASE_ERROR", kind: "database", outcome: "unknown" },
      ],
      [new Error("boom"), 500, "boom", { code: "INTERNAL_ERROR" }],
    ];
    assert.equal(TIMEOUT_SENTENCE, "Query timed out. Please try a simpler query or increase timeout.");
    const { host } = await initialized({
      listContainers: async (params) => {
        throw rows[(params as { row: number }).row][0];
      },
    });
    await Promise.all(
      rows.map(async ([error, code, message, data], row) => {
        const answer = await answeredError(host, METHODS.listContainers, { connectionId: "c1", row });
        assert.deepEqual(answer, { code, message, data });
        // The route and the child answer from one implementation, so they cannot drift.
        const route = databaseErrorBody(error)?.body ?? internalErrorBody(error);
        assert.deepEqual([answer.code, answer.message, answer.data?.code], [route.statusCode, route.error, route.code]);
      }),
    );
  });

  it("a provider error's SQLSTATE reaches the client in data.sqlState", async () => {
    const missing = new QueryError('relation "app" does not exist', "postgres");
    missing.sqlstate = "42P01";
    const made = fakeFactory(
      fakeProvider({
        listContainers: async () => {
          throw missing;
        },
      }),
    );
    const { host } = await initialized({}, made);
    await host.sendRequest(METHODS.openConnection, { connection: WIRE, posture: POSTURE });
    assert.deepEqual(await answeredError(host, METHODS.listContainers, { connectionId: "c1" }), {
      code: 400,
      message: 'relation "app" does not exist',
      data: { code: "QUERY_ERROR", kind: "query", outcome: "unknown", sqlState: "42P01" },
    });
  });

  it("passes the extension's own refusals on with their code and data, and InvalidParams with none", async () => {
    const { host } = await initialized({
      runQuery: async () => {
        throw refusal(413, "TEXT_TOO_LARGE", "The statement is 65537 bytes in UTF-8, over the 65536-byte limit.");
      },
      cancelQuery: async () => {
        throw refusal(400, "CANCEL_UNSUPPORTED", "Query cancellation is not supported for this database type");
      },
    });
    assert.deepEqual(await answeredError(host, METHODS.runQuery, RUN), {
      code: 413,
      message: "The statement is 65537 bytes in UTF-8, over the 65536-byte limit.",
      data: { code: "TEXT_TOO_LARGE" },
    });
    assert.deepEqual(await answeredError(host, METHODS.cancelQuery, { connectionId: "c1", queryId: "q-7" }), {
      code: 400,
      message: "Query cancellation is not supported for this database type",
      data: { code: "CANCEL_UNSUPPORTED" },
    });
    assert.deepEqual(await answeredError(host, METHODS.listContainers, { connectionId: "c9" }), {
      code: 404,
      message: 'No connection with id "c9" is open in this LibreDB backend.',
      data: { code: "CONNECTION_NOT_OPEN" },
    });
    assert.deepEqual(await answeredError(host, METHODS.closeConnection, { connectionId: 3 }), {
      code: -32602,
      message: "connectionId must be a non-empty string",
    });
  });

  it("answers a value JSON cannot carry as that request's INTERNAL_ERROR, and keeps serving", async () => {
    const { host } = await initialized({ runQuery: async () => ({ rows: [{ n: 1n }] }) as never });
    assert.deepEqual(await answeredError(host, METHODS.runQuery, RUN), {
      code: 500,
      message: "Do not know how to serialize a BigInt",
      data: { code: "INTERNAL_ERROR" },
    });
    assert.equal(await host.sendRequest(METHODS.closeConnection, { connectionId: "c1" }), null);
  });

  it("closes every provider on shutdown, then refuses every request, initialize included", async () => {
    const { host, calls } = await initialized();
    assert.equal(await host.sendRequest(METHODS.shutdown), null);
    assert.deepEqual(calls, [["clearProviderCache"]]);
    const shuttingDown = {
      code: 503,
      message: "The LibreDB backend is shutting down.",
      data: { code: "SHUTTING_DOWN" },
    };
    assert.deepEqual(await answeredError(host, METHODS.runQuery, RUN), shuttingDown);
    assert.deepEqual(await answeredError(host, METHODS.initialize, { protocolVersion: 2 }), shuttingDown);
    assert.deepEqual(await answeredError(host, METHODS.listEngines, {}), shuttingDown);
    assert.deepEqual(await answeredError(host, METHODS.parsePastedConnection, { text: "hello" }), shuttingDown);
  });

  it("exits 0 on the exit notification", async () => {
    const { host, exits } = await initialized();
    await host.sendNotification(EXIT_NOTIFICATION);
    // The child handles its messages in order, so the notification has run once a later request is answered.
    await host.sendRequest(METHODS.closeConnection, { connectionId: "c1" });
    assert.deepEqual(exits, [0]);
  });

  it("hands the request's token to the handler, which $/cancelRequest cancels", async () => {
    const { host } = await initialized({
      runQuery: (_params: unknown, token: CancellationToken) =>
        new Promise((_resolve, reject) => {
          token.onCancellationRequested(() => reject(new QueryCancelledError("The query was cancelled.", "postgres")));
        }),
    });
    const source = new CancellationTokenSource();
    const answer = host.sendRequest(METHODS.runQuery, RUN, source.token);
    await settled();
    source.cancel();
    await assert.rejects(answer, (error) => error instanceof ResponseError && error.code === 499);
  });

  it("writes no line holding a secret it was sent", async () => {
    const failing = fakeFactory(fakeProvider(), {
      testConnection: async () => {
        throw new AuthenticationError('password authentication failed for user "app"', "postgres");
      },
    });
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      const { host } = await initialized({}, failing);
      await host.sendRequest(METHODS.openConnection, { connection: WIRE, posture: POSTURE });
      assert.equal(
        (await answeredError(host, METHODS.testConnection, { connection: WIRE, posture: POSTURE })).code,
        401,
      );
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index];
      });
    }
    assert.deepEqual(
      lines.filter((line) => line.includes(TEST_PASSWORD)),
      [],
    );
  });
});
