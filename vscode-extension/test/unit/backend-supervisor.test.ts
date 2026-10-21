import assert from "node:assert/strict";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { join } from "node:path";
import { type Clock, install } from "@sinonjs/fake-timers";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc";
import {
  type BackendCrash,
  type BackendExit,
  type BackendState,
  BackendSupervisor,
  BackendUnavailableError,
  BUDGET_SPENT,
  CRASH_WARNING,
  INITIALIZE_TIMEOUT_MS,
  READY_RESET_MS,
  RESTART_DELAYS_MS,
  STDERR_TAIL_LINES,
  STOP_STEP_MS,
} from "../../src/host/backend-supervisor";
import { backendForkOptions } from "../../src/host/fork-options";
import { METHODS } from "../../src/protocol";
import { FakeChild, type Serve } from "../fakes/child";
import { answerMessages, shownMessages, window } from "../fakes/vscode";
import { TEST_PASSWORD } from "../fakes/credentials";

const INITIALIZED = {
  protocolVersion: 1,
  runtime: { node: "24.21.0", electron: "43.7.7", modules: "148", platform: "linux", arch: "x64" },
  enabledProviders: ["postgres", "mssql", "mysql", "mongodb"],
};
const READY_LINE =
  "The LibreDB backend is ready: Node 24.21.0, Electron 43.7.7, modules 148, linux/x64; enabled providers: postgres, mssql, mysql, mongodb.";
const DEADLINE = "The LibreDB backend did not answer its handshake within 10 s.";
const STOPPING = "The LibreDB backend is stopping.";

/** A child that answers initialize and shutdown, and leaves every other request unanswered. */
const healthy: Serve = (request) => {
  if (request.method === METHODS.initialize) return { result: INITIALIZED };
  return request.method === METHODS.shutdown ? { result: null } : "never";
};

/** A child that ends with exit code 0 once it receives the exit notification, as the real child does. */
function exitsOnExit(child: FakeChild): void {
  child.serve = healthy;
  child.notified = (method) => {
    if (method === "exit") setImmediate(() => child.exit(0));
  };
}

/** vscode-jsonrpc handles a message on a later setImmediate turn, which the fake clock leaves real. */
function settle(turns = 10): Promise<void> {
  return new Promise((resolve) => setImmediate(() => (turns > 1 ? settle(turns - 1).then(resolve) : resolve())));
}

/** The settled outcome of a promise: its value, or the error it rejected with. */
function outcome<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function harness(prepare: (child: FakeChild, generation: number) => void = (child) => (child.serve = healthy)) {
  const children: FakeChild[] = [];
  const forks: [string, readonly string[], ForkOptions][] = [];
  const log = window.createOutputChannel("LibreDB", { log: true });
  let showLogs = 0;
  const supervisor = new BackendSupervisor({
    fork(modulePath, args, options) {
      forks.push([modulePath, args, options]);
      const child = new FakeChild();
      children.push(child);
      prepare(child, children.length);
      return child as unknown as ChildProcess;
    },
    extensionPath: "/ext",
    log,
    window,
    showLog: async () => {
      showLogs += 1;
    },
  });
  const states: BackendState[] = [];
  supervisor.onDidChangeState((state) => states.push(state));
  return { supervisor, children, forks, log, states, showLogs: () => showLogs };
}

const warnings = () => shownMessages.filter((shown) => shown.level === "warning");
const errors = () => shownMessages.filter((shown) => shown.level === "error");

describe("BackendSupervisor", () => {
  let clock: Clock;

  beforeEach(() => {
    clock = install({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    clock.uninstall();
  });

  /** Moves the fake clock, then lets vscode-jsonrpc handle what the step sent. */
  async function advance(ms: number): Promise<void> {
    await clock.tickAsync(ms);
    await settle();
  }

  /** Crashes the current child and checks that the next fork comes exactly `delay` ms later and gets ready. */
  async function restartsAfter(h: ReturnType<typeof harness>, delay: number): Promise<void> {
    const forks = h.forks.length;
    h.children[forks - 1].exit(1);
    await advance(delay - 1);
    assert.equal(h.forks.length, forks);
    await advance(1);
    assert.equal(h.forks.length, forks + 1);
    assert.equal(h.supervisor.state, "ready");
  }

  it("holds part 1's deadline, restart delays, reset, stop step and stderr tail", () => {
    assert.equal(INITIALIZE_TIMEOUT_MS, 10_000);
    assert.deepEqual(RESTART_DELAYS_MS, [1000, 5000, 15000]);
    assert.equal(READY_RESET_MS, 60_000);
    assert.equal(STOP_STEP_MS, 2000);
    assert.equal(STDERR_TAIL_LINES, 50);
  });

  it("forks nothing until the first call, then once for concurrent calls (criterion 1)", async () => {
    const { supervisor, children, forks } = harness();
    assert.equal(supervisor.state, "stopped");
    assert.equal(supervisor.generation, 0);
    assert.equal(supervisor.pid, undefined);
    assert.deepEqual(forks, []);
    const [first, second, third] = await Promise.all([
      supervisor.connection(),
      supervisor.connection(),
      supervisor.connection(),
    ]);
    assert.deepEqual(forks, [[join("/ext", "dist", "backend.js"), [], backendForkOptions("/ext")]]);
    assert.equal(first.connection, second.connection);
    assert.equal(second.connection, third.connection);
    assert.equal(first.generation, 1);
    assert.deepEqual(first.initialized, INITIALIZED);
    assert.equal((await supervisor.connection()).connection, first.connection);
    assert.equal(supervisor.pid, children[0].pid);
  });

  it("sends initialize first, is starting until the answer, and logs the start and the runtime", async () => {
    const { supervisor, children, log, states } = harness();
    const ready = supervisor.connection();
    assert.equal(supervisor.state, "starting");
    assert.equal(supervisor.pid, children[0].pid);
    assert.deepEqual(children[0].received, [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } },
    ]);
    await ready;
    assert.equal(supervisor.state, "ready");
    assert.deepEqual(states, ["starting", "ready"]);
    assert.deepEqual(log.lines, [
      [
        "info",
        `Starting the LibreDB backend (generation 1) from ${process.execPath}; ELECTRON_RUN_AS_NODE in the host: ${process.env.ELECTRON_RUN_AS_NODE ?? "unset"}.`,
      ],
      ["info", READY_LINE],
    ]);
  });

  it("logs no Electron as none and no provider list as all", async () => {
    const { supervisor, log } = harness((child) => {
      const runtime = { ...INITIALIZED.runtime, electron: null };
      child.serve = () => ({ result: { ...INITIALIZED, runtime, enabledProviders: null } });
    });
    await supervisor.connection();
    assert.deepEqual(log.lines.at(-1), [
      "info",
      "The LibreDB backend is ready: Node 24.21.0, Electron none, modules 148, linux/x64; enabled providers: all.",
    ]);
  });

  it("logs the child's stdout lines at info and its stderr lines at warn, as written", async () => {
    const { supervisor, children, log } = harness();
    await supervisor.connection();
    children[0].stdout.write('[DB] Creating postgres provider for "Orders"\n');
    children[0].stderr.write("(node:1) Warning: x\n");
    await settle();
    assert.deepEqual(log.lines.slice(2), [
      ["info", '[DB] Creating postgres provider for "Orders"'],
      ["warn", "(node:1) Warning: x"],
    ]);
  });

  it("logs an error event of a child past its handshake and keeps it", async () => {
    const { supervisor, children, log } = harness();
    await supervisor.connection();
    children[0].emit("error", new Error("kill EPERM"));
    assert.deepEqual(log.lines.at(-1), ["error", "The LibreDB backend reported an error: kill EPERM"]);
    assert.equal(supervisor.state, "ready");
    assert.deepEqual(shownMessages, []);
  });

  describe("a failed start", () => {
    it("kills a child that has not answered its handshake at 10 s and restarts it 1 s later", async () => {
      const { supervisor, children, forks, log } = harness((child, generation) => {
        if (generation > 1) child.serve = healthy;
      });
      const waiting = outcome(supervisor.connection());
      await advance(9_999);
      assert.equal(supervisor.state, "starting");
      assert.deepEqual(children[0].killed, []);
      await advance(1);
      assert.deepEqual(children[0].killed, ["SIGKILL"]);
      assert.deepEqual(log.lines.at(-1), ["error", DEADLINE]);
      const result = await waiting;
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, DEADLINE);
      assert.equal(result.error.state, "restarting");
      assert.deepEqual(warnings(), [{ level: "warning", message: CRASH_WARNING, items: ["Show Log"] }]);
      assert.equal(supervisor.state, "restarting");
      await advance(999);
      assert.equal(forks.length, 1);
      await advance(1);
      assert.equal(forks.length, 2);
      assert.equal(supervisor.state, "ready");
      children[0].exit(null, "SIGKILL");
      assert.equal(supervisor.state, "ready");
      assert.equal(warnings().length, 1);
    });

    it("takes the same path for a child that could not be spawned", async () => {
      const { supervisor, children, forks, log } = harness((child, generation) => {
        if (generation > 1) child.serve = healthy;
      });
      const waiting = outcome(supervisor.connection());
      children[0].emit("error", new Error("spawn /x ENOENT"));
      const result = await waiting;
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, "The LibreDB backend could not start: spawn /x ENOENT");
      assert.deepEqual(log.lines.at(-1), ["error", "The LibreDB backend could not start: spawn /x ENOENT"]);
      assert.deepEqual(warnings(), [{ level: "warning", message: CRASH_WARNING, items: ["Show Log"] }]);
      children[0].exit(-2);
      assert.equal(warnings().length, 1);
      await advance(1_000);
      assert.equal(forks.length, 2);
    });

    // Node's spawn throws, rather than emitting error, for any errno but EACCES, EAGAIN, EMFILE, ENFILE and ENOENT.
    it("takes the same path for a first fork that throws", async () => {
      const { supervisor, forks, log } = harness((child, generation) => {
        if (generation === 1) throw new Error("spawn E2BIG");
        child.serve = healthy;
      });
      const result = await outcome(Promise.resolve().then(() => supervisor.connection()));
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, "The LibreDB backend could not start: spawn E2BIG");
      assert.equal(result.error.state, "restarting");
      assert.deepEqual(log.lines.at(-1), ["error", "The LibreDB backend could not start: spawn E2BIG"]);
      assert.deepEqual(warnings(), [{ level: "warning", message: CRASH_WARNING, items: ["Show Log"] }]);
      assert.equal(supervisor.state, "restarting");
      await advance(1_000);
      assert.equal(forks.length, 2);
      assert.equal(supervisor.state, "ready");
    });

    it("takes the same path for a fork that throws on a restart, and rejects the call waiting for it", async () => {
      const { supervisor, children, forks, log } = harness((child, generation) => {
        if (generation === 2) throw new Error("spawn EPERM");
        child.serve = healthy;
      });
      await supervisor.connection();
      children[0].exit(null, "SIGKILL");
      const waiting = outcome(supervisor.connection());
      await advance(1_000);
      const result = await waiting;
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, "The LibreDB backend could not start: spawn EPERM");
      assert.deepEqual(log.lines.at(-1), ["error", "The LibreDB backend could not start: spawn EPERM"]);
      assert.equal(supervisor.state, "restarting");
      assert.equal(warnings().length, 2);
      await advance(5_000);
      assert.equal(forks.length, 3);
      assert.equal(supervisor.state, "ready");
    });

    it("takes the same path for a child that exits before it answers", async () => {
      const { supervisor, children, forks } = harness((child, generation) => {
        if (generation > 1) child.serve = healthy;
      });
      const waiting = outcome(supervisor.connection());
      children[0].exit(1);
      const result = await waiting;
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, "The LibreDB backend exited (exit code 1, signal none).");
      assert.deepEqual(supervisor.lastExit, { exitCode: 1, signal: null });
      await advance(1_000);
      assert.equal(forks.length, 2);
    });

    it("lets a call made while restarting share the next start", async () => {
      const { supervisor, children } = harness();
      await supervisor.connection();
      children[0].exit(1);
      const waiting = supervisor.connection();
      await advance(1_000);
      assert.equal((await waiting).generation, 2);
    });
  });

  for (const code of ["RUNTIME_UNSUPPORTED", "PROTOCOL_MISMATCH"]) {
    it(`goes straight to failed when the child refuses initialize with ${code} (criterion 3)`, async () => {
      const sentence = "The LibreDB backend needs Node 24.0.0 or later and was started on Node 22.11.0.";
      const { supervisor, children, forks } = harness((child) => {
        child.serve = () => ({ error: { code: 500, message: sentence, data: { code } } });
      });
      const result = await outcome(supervisor.connection());
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, sentence);
      assert.equal(result.error.state, "failed");
      assert.equal(supervisor.state, "failed");
      assert.deepEqual(errors(), [{ level: "error", message: sentence, items: ["Show Log"] }]);
      assert.deepEqual(children[0].killed, ["SIGTERM"]);
      children[0].exit(null, "SIGTERM");
      assert.deepEqual(warnings(), []);
      await advance(60_000);
      assert.equal(forks.length, 1);
    });
  }

  describe("a crash", () => {
    for (const [exitCode, signal] of [
      [0, null],
      [null, "SIGKILL"],
    ] as const) {
      it(`counts an exit (${exitCode}, ${signal}) from ready as a crash (criteria 10 and 11)`, async () => {
        const { supervisor, children } = harness();
        await supervisor.connection();
        const crashes: BackendCrash[] = [];
        supervisor.onDidCrash((crash) => crashes.push(crash));
        children[0].exit(exitCode, signal);
        assert.equal(supervisor.state, "restarting");
        assert.deepEqual(crashes, [{ exit: { exitCode, signal }, generation: 1 }]);
        assert.deepEqual(warnings(), [{ level: "warning", message: CRASH_WARNING, items: ["Show Log"] }]);
      });
    }

    it("is past ready when onDidCrash fires, so a listener's call waits for the next child", async () => {
      const { supervisor, children } = harness();
      await supervisor.connection();
      const inside: { state: BackendState; next: ReturnType<typeof outcome> }[] = [];
      supervisor.onDidCrash(() => {
        inside.push({ state: supervisor.state, next: outcome(supervisor.connection()) });
      });
      children[0].exit(null, "SIGKILL");
      assert.equal(inside.length, 1);
      assert.equal(inside[0].state, "restarting");
      await advance(1_000);
      const result = await inside[0].next;
      assert.ok("value" in result);
      assert.equal((result.value as { generation: number }).generation, 2);
    });

    it("rejects a pending request with PendingResponseRejected once lastExit is recorded", async () => {
      const { supervisor, children } = harness();
      const { connection } = await supervisor.connection();
      let seen: BackendExit | undefined;
      const pending = connection.sendRequest(METHODS.listContainers, { connectionId: "c1" }).then(
        () => assert.fail("the request was answered"),
        (error: unknown) => {
          seen = supervisor.lastExit;
          return error;
        },
      );
      await settle();
      children[0].exit(null, "SIGKILL");
      const error = await pending;
      assert.ok(error instanceof ResponseError);
      assert.equal(error.code, ErrorCodes.PendingResponseRejected);
      assert.deepEqual(seen, { exitCode: null, signal: "SIGKILL" });
    });

    it("logs the exit with the child's last 50 stderr lines", async () => {
      const { supervisor, children, log } = harness();
      await supervisor.connection();
      for (let line = 1; line <= 60; line += 1) children[0].stderr.write(`e${line}\n`);
      await settle();
      children[0].exit(1);
      const tail = Array.from({ length: 50 }, (_, index) => `e${index + 11}`);
      assert.deepEqual(
        log.lines.filter(([level]) => level === "error"),
        [
          [
            "error",
            ["The LibreDB backend exited (exit code 1, signal none). Its last 50 stderr lines:", ...tail].join("\n"),
          ],
        ],
      );
    });

    it("says so when the child wrote nothing to stderr", async () => {
      const { supervisor, children, log } = harness();
      await supervisor.connection();
      children[0].exit(1);
      assert.deepEqual(log.lines.at(-1), [
        "error",
        "The LibreDB backend exited (exit code 1, signal none). It wrote nothing to stderr.",
      ]);
    });

    it("restarts after 1 s, 5 s and 15 s, then fails and says so once (criterion 11)", async () => {
      const h = harness();
      await h.supervisor.connection();
      await restartsAfter(h, 1_000);
      await restartsAfter(h, 5_000);
      await restartsAfter(h, 15_000);
      h.children[3].exit(1);
      await advance(60_000);
      assert.equal(h.forks.length, 4);
      assert.equal(h.supervisor.state, "failed");
      assert.deepEqual(errors(), [{ level: "error", message: BUDGET_SPENT, items: ["Show Log", "Restart"] }]);
      assert.equal(warnings().length, 3);
    });

    it("resets the count once a child has been ready for 60 s", async () => {
      const h = harness();
      await h.supervisor.connection();
      await restartsAfter(h, 1_000);
      await advance(59_999);
      h.children[1].exit(1);
      await advance(4_999);
      assert.equal(h.forks.length, 2);
      await advance(1);
      assert.equal(h.forks.length, 3);
      await advance(60_000);
      h.children[2].exit(1);
      await advance(999);
      assert.equal(h.forks.length, 3);
      await advance(1);
      assert.equal(h.forks.length, 4);
    });
  });

  describe("the notifications' buttons", () => {
    it("runs libredb.showLog from the crash warning's Show Log", async () => {
      answerMessages(({ message }) => (message === CRASH_WARNING ? "Show Log" : undefined));
      const h = harness();
      await h.supervisor.connection();
      h.children[0].exit(1);
      await settle();
      assert.equal(h.showLogs(), 1);
    });

    it("runs libredb.showLog from the failure's Show Log", async () => {
      answerMessages(({ level }) => (level === "error" ? "Show Log" : undefined));
      const h = harness((child) => {
        child.serve = () => ({ error: { code: 500, message: "refused", data: { code: "PROTOCOL_MISMATCH" } } });
      });
      await outcome(h.supervisor.connection());
      await settle();
      assert.equal(h.showLogs(), 1);
    });

    it("starts generation 5 from Restart, with the count reset", async () => {
      answerMessages(({ message }) => (message === BUDGET_SPENT ? "Restart" : undefined));
      const h = harness();
      await h.supervisor.connection();
      await restartsAfter(h, 1_000);
      await restartsAfter(h, 5_000);
      await restartsAfter(h, 15_000);
      h.children[3].exit(1);
      await settle();
      assert.equal(h.forks.length, 5);
      assert.equal(h.supervisor.generation, 5);
      assert.equal(h.supervisor.state, "ready");
      h.children[4].exit(1);
      await advance(1_000);
      assert.equal(h.forks.length, 6);
    });
  });

  it("holds failed: a call shows the failure again, rejects and forks nothing", async () => {
    const h = harness();
    await h.supervisor.connection();
    await restartsAfter(h, 1_000);
    await restartsAfter(h, 5_000);
    await restartsAfter(h, 15_000);
    h.children[3].exit(1);
    const result = await outcome(h.supervisor.connection());
    assert.ok("error" in result && result.error instanceof BackendUnavailableError);
    assert.equal(result.error.message, BUDGET_SPENT);
    assert.equal(result.error.state, "failed");
    assert.deepEqual(
      errors().map(({ message }) => message),
      [BUDGET_SPENT, BUDGET_SPENT],
    );
    assert.equal(h.forks.length, 4);
  });

  describe("stop (criterion 12)", () => {
    it("resolves at once when no child was ever started", async () => {
      const { supervisor, forks } = harness();
      await supervisor.stop();
      assert.equal(supervisor.state, "stopped");
      assert.deepEqual(forks, []);
    });

    it("fires onWillStop, sends shutdown then exit, and resolves on the child's exit", async () => {
      const { supervisor, children, states } = harness(exitsOnExit);
      await supervisor.connection();
      const seenAtWillStop: string[][] = [];
      supervisor.onWillStop(() => seenAtWillStop.push(children[0].methods()));
      await supervisor.stop();
      assert.deepEqual(seenAtWillStop, [["initialize"]]);
      assert.deepEqual(children[0].methods(), ["initialize", "shutdown", "exit"]);
      assert.deepEqual(children[0].killed, []);
      assert.deepEqual(shownMessages, []);
      assert.equal(supervisor.state, "stopped");
      assert.deepEqual(states, ["starting", "ready", "stopping", "stopped"]);
    });

    it("sends SIGTERM at 2 s when shutdown goes unanswered", async () => {
      const { supervisor, children } = harness((child) => {
        child.serve = (request) => (request.method === METHODS.initialize ? { result: INITIALIZED } : "never");
      });
      await supervisor.connection();
      const stopped = supervisor.stop();
      await advance(1_999);
      assert.deepEqual(children[0].killed, []);
      await advance(1);
      assert.deepEqual(children[0].killed, ["SIGTERM"]);
      assert.deepEqual(children[0].methods(), ["initialize", "shutdown"]);
      children[0].exit(null, "SIGTERM");
      await stopped;
      assert.equal(supervisor.state, "stopped");
      assert.deepEqual(shownMessages, []);
    });

    it("sends SIGTERM 2 s after exit, then SIGKILL 2 s after SIGTERM, to a child that lives on", async () => {
      const { supervisor, children } = harness();
      await supervisor.connection();
      const stopped = supervisor.stop();
      await settle();
      assert.deepEqual(children[0].methods(), ["initialize", "shutdown", "exit"]);
      await advance(1_999);
      assert.deepEqual(children[0].killed, []);
      await advance(1);
      assert.deepEqual(children[0].killed, ["SIGTERM"]);
      await advance(1_999);
      assert.deepEqual(children[0].killed, ["SIGTERM"]);
      await advance(1);
      assert.deepEqual(children[0].killed, ["SIGTERM", "SIGKILL"]);
      await stopped;
      assert.equal(supervisor.state, "stopped");
    });

    it("clears a pending restart", async () => {
      const { supervisor, children, forks } = harness();
      await supervisor.connection();
      children[0].exit(1);
      assert.equal(supervisor.state, "restarting");
      await supervisor.stop();
      assert.equal(supervisor.state, "stopped");
      await advance(60_000);
      assert.equal(forks.length, 1);
    });

    it("waits for a handshake in flight, then runs the sequence", async () => {
      const { supervisor, children } = harness((child) => {
        exitsOnExit(child);
        child.serve = (request) => (request.method === METHODS.shutdown ? { result: null } : "never");
      });
      const waiting = outcome(supervisor.connection());
      const stopped = supervisor.stop();
      assert.equal(supervisor.state, "stopping");
      await settle();
      assert.deepEqual(children[0].methods(), ["initialize"]);
      children[0].reply({ id: 0, result: INITIALIZED });
      await stopped;
      assert.deepEqual(children[0].methods(), ["initialize", "shutdown", "exit"]);
      assert.equal(supervisor.state, "stopped");
      const result = await waiting;
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, STOPPING);
    });

    it("returns the same promise twice and refuses calls while stopping", async () => {
      const { supervisor } = harness(exitsOnExit);
      await supervisor.connection();
      const stopped = supervisor.stop();
      assert.equal(supervisor.stop(), stopped);
      const result = await outcome(supervisor.connection());
      assert.ok("error" in result && result.error instanceof BackendUnavailableError);
      assert.equal(result.error.message, STOPPING);
      assert.equal(result.error.state, "stopping");
      await stopped;
    });
  });

  it("puts no secret in the child's arguments or environment (criterion 2)", async () => {
    const { supervisor, children, forks } = harness();
    const { connection } = await supervisor.connection();
    const params = { connection: { id: "c1", type: "postgres", password: TEST_PASSWORD }, posture: {} };
    void connection.sendRequest(METHODS.openConnection, params).catch(() => {});
    await settle();
    assert.ok(JSON.stringify(children[0].received).includes(TEST_PASSWORD));
    assert.equal(JSON.stringify(forks).includes(TEST_PASSWORD), false);
  });
});
