import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type Clock, install } from "@sinonjs/fake-timers";
import type { BackendFactory } from "../../src/backend/handlers";
import {
  type BackendProcess,
  DISCONNECT_CLOSE_FAILED,
  DISCONNECT_CLOSE_MS,
  NO_IPC_CHANNEL,
  startBackend,
} from "../../src/backend/start";

const VERSIONS = { ...process.versions, node: "24.21.0", electron: "43.7.7", modules: "148" };

/** A child's process over a fake IPC channel: the host's messages are emitted as message, the child's recorded. */
class FakeProcess extends EventEmitter implements BackendProcess {
  readonly versions = VERSIONS;
  readonly platform = "linux";
  readonly arch = "x64";
  readonly sent: unknown[] = [];
  readonly exits: number[] = [];

  send(message: unknown, _handle?: unknown, _options?: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  exit(code: number): never {
    this.exits.push(code);
    return undefined as never;
  }
}

function fakeFactory(clearProviderCache: () => Promise<void>) {
  let clears = 0;
  const factory: BackendFactory = {
    getOrCreateProvider: () => Promise.reject(new Error("not called")),
    removeProvider: () => Promise.reject(new Error("not called")),
    clearProviderCache: () => {
      clears += 1;
      return clearProviderCache();
    },
    enabledProviderTypes: () => ["postgres", "mssql", "mysql", "mongodb"],
    testConnection: () => Promise.reject(new Error("not called")),
  };
  return { factory, clears: () => clears };
}

/** vscode-jsonrpc handles a message on a later setImmediate turn, which the fake clock leaves real. */
function settle(turns = 5): Promise<void> {
  return new Promise((resolve) => setImmediate(() => (turns > 1 ? settle(turns - 1).then(resolve) : resolve())));
}

describe("startBackend", () => {
  it("refuses to start without an IPC channel", () => {
    const noIpc: BackendProcess = {
      versions: VERSIONS,
      platform: "linux",
      arch: "x64",
      on: () => undefined,
      once: () => undefined,
      exit: (() => undefined) as unknown as BackendProcess["exit"],
    };
    assert.throws(() => startBackend(noIpc, fakeFactory(async () => {}).factory, ">=24.0.0"), {
      message: NO_IPC_CHANNEL,
    });
  });

  it("answers initialize over the IPC channel with its runtime and its enabled providers", async () => {
    const proc = new FakeProcess();
    const connection = startBackend(proc, fakeFactory(async () => {}).factory, ">=24.0.0");
    proc.emit("message", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await settle();
    assert.deepEqual(proc.sent, [
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          runtime: { node: "24.21.0", electron: "43.7.7", modules: "148", platform: "linux", arch: "x64" },
          enabledProviders: ["postgres", "mssql", "mysql", "mongodb"],
        },
      },
    ]);
    connection.dispose();
  });

  it("exits 0 on the exit notification", async () => {
    const proc = new FakeProcess();
    const connection = startBackend(proc, fakeFactory(async () => {}).factory, ">=24.0.0");
    proc.emit("message", { jsonrpc: "2.0", method: "exit" });
    await settle();
    assert.deepEqual(proc.exits, [0]);
    connection.dispose();
  });

  describe("once its host closes the channel", () => {
    let clock: Clock;
    let errors: unknown[][];
    const consoleError = console.error;

    beforeEach(() => {
      clock = install({ toFake: ["setTimeout", "clearTimeout"] });
      errors = [];
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };
    });

    afterEach(() => {
      clock.uninstall();
      console.error = consoleError;
    });

    it("closes every pool once and exits 0 only after the close resolves", async () => {
      let close = () => {};
      const { factory, clears } = fakeFactory(() => new Promise<void>((resolve) => (close = resolve)));
      const proc = new FakeProcess();
      startBackend(proc, factory, ">=24.0.0");
      proc.emit("disconnect");
      await clock.tickAsync(100);
      assert.equal(clears(), 1);
      assert.deepEqual(proc.exits, []);
      close();
      await clock.tickAsync(0);
      assert.deepEqual(proc.exits, [0]);
      assert.equal(clears(), 1);
      assert.deepEqual(errors, []);
    });

    it("exits 0 at 2,000 ms when the close never resolves", async () => {
      const proc = new FakeProcess();
      startBackend(proc, fakeFactory(() => new Promise<void>(() => {})).factory, ">=24.0.0");
      proc.emit("disconnect");
      await clock.tickAsync(DISCONNECT_CLOSE_MS - 1);
      assert.equal(DISCONNECT_CLOSE_MS, 2000);
      assert.deepEqual(proc.exits, []);
      await clock.tickAsync(1);
      assert.deepEqual(proc.exits, [0]);
      assert.deepEqual(errors, []);
    });

    it("logs a close that fails, then exits 0, as the factory's signal handler does", async () => {
      const failure = new Error("pool hung");
      const proc = new FakeProcess();
      startBackend(proc, fakeFactory(() => Promise.reject(failure)).factory, ">=24.0.0");
      proc.emit("disconnect");
      await clock.tickAsync(0);
      assert.deepEqual(errors, [[DISCONNECT_CLOSE_FAILED, failure]]);
      assert.deepEqual(proc.exits, [0]);
    });
  });
});

describe("the child entry", () => {
  it("starts the backend on its own process, which under Mocha has no IPC channel", async () => {
    await assert.rejects(import("../../src/backend/main"), { message: NO_IPC_CHANNEL });
  });
});
