import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { BackendClient, BackendExitedError, type ConnectionSource } from "../../src/host/backend-client";
import {
  BackendSupervisor,
  type BackendState,
  BUDGET_SPENT,
  CRASH_WARNING,
  type SupervisorDeps,
} from "../../src/host/backend-supervisor";
import { OpenConnections } from "../../src/host/open-connections";
import type { ConnectionParams } from "../../src/protocol";
import { type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "../integration/containers";
import { engineFixture } from "../integration/engines";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

/** The installed extension, activated: its own supervisor stays unreachable, since activate exports nothing. */
async function installedExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
  await extension.activate();
  return extension;
}

/** The command lines of this extension host's children that run dist/backend.js. */
async function backendChildren(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "--ppid", String(process.pid)]);
    return stdout.split("\n").filter((line) => line.includes("dist/backend.js"));
  } catch (error) {
    // ps exits 1, printing nothing, when the process has no children at all.
    if ((error as { code?: unknown; stdout?: unknown }).code === 1 && (error as { stdout?: unknown }).stdout === "") {
      return [];
    }
    throw error;
  }
}

/** What the supervisor logged and showed, and the answers the test gives its error notifications. */
interface Recording {
  readonly info: string[];
  readonly warnings: string[][];
  readonly errors: string[][];
  /** Answers the oldest unanswered error notification. */
  answerError(choice: string | undefined): void;
}

function recordingDeps(extensionPath: string): { deps: SupervisorDeps; recording: Recording } {
  const info: string[] = [];
  const warnings: string[][] = [];
  const errors: string[][] = [];
  const unanswered: ((choice: string | undefined) => void)[] = [];
  const window = {
    showWarningMessage: (message: string, ...items: string[]) => {
      warnings.push([message, ...items]);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string, ...items: string[]) => {
      errors.push([message, ...items]);
      return new Promise<string | undefined>((resolve) => unanswered.push(resolve));
    },
  } as unknown as SupervisorDeps["window"];
  const deps: SupervisorDeps = {
    fork,
    extensionPath,
    log: {
      info: (message: string) => info.push(message),
      warn: () => undefined,
      error: () => undefined,
    },
    window,
    showLog: () => Promise.resolve(),
  };
  const answerError = (choice: string | undefined): void => {
    const answer = unanswered.shift();
    assert.ok(answer, "no error notification is waiting for an answer");
    answer(choice);
  };
  return { deps, recording: { info, warnings, errors, answerError } };
}

/** Resolves with the time the supervisor next enters `state`. */
function nextState(supervisor: BackendSupervisor, state: BackendState): Promise<number> {
  return new Promise((resolve) => {
    const listener = supervisor.onDidChangeState((entered) => {
      if (entered !== state) return;
      listener.dispose();
      resolve(Date.now());
    });
  });
}

describe("the backend's lifecycle in a real extension host", () => {
  let supervisor: BackendSupervisor | undefined;
  let engine: RunningEngine | undefined;

  afterEach(async function () {
    this.timeout(60_000);
    const started = Date.now();
    try {
      await supervisor?.stop();
      console.log(`the supervisor stopped in ${Date.now() - started} ms`);
    } finally {
      supervisor = undefined;
      if (engine !== undefined) {
        const removing = Date.now();
        await stopEngine(engine);
        console.log(`the PostgreSQL container was removed in ${Date.now() - removing} ms`);
      }
      engine = undefined;
    }
  });

  it("forks nothing on activation, and one child for three concurrent first calls", async function () {
    this.timeout(120_000);
    // The extension's own child, when an earlier file expanded a connection in the Connections tree, runs throughout
    // and is unreachable, so the check counts from the children that ran before this case.
    const before = await backendChildren();
    const { extensionPath } = await installedExtension();
    assert.deepEqual(await backendChildren(), before);
    supervisor = new BackendSupervisor(recordingDeps(extensionPath).deps);
    assert.deepEqual(await backendChildren(), before);
    await Promise.all([supervisor.connection(), supervisor.connection(), supervisor.connection()]);
    assert.equal((await backendChildren()).length, before.length + 1);
  });

  it("logs the host's execPath and ELECTRON_RUN_AS_NODE, and a child that runs on Electron", async function () {
    this.timeout(120_000);
    const { deps, recording } = recordingDeps((await installedExtension()).extensionPath);
    supervisor = new BackendSupervisor(deps);
    await supervisor.connection();
    const starting = `Starting the LibreDB backend (generation 1) from ${process.execPath}; ELECTRON_RUN_AS_NODE in the host: ${process.env.ELECTRON_RUN_AS_NODE ?? "unset"}.`;
    const ready = recording.info.find((line) => line.startsWith("The LibreDB backend is ready: "));
    console.log(`VS Code ${vscode.version}: ${starting}`);
    console.log(`VS Code ${vscode.version}: ${ready}`);
    assert.ok(recording.info.includes(starting), JSON.stringify(recording.info));
    assert.match(ready ?? "", /^The LibreDB backend is ready: Node \d+\.\d+\.\d+, Electron \d+\.\d+\.\d+, /);
  });

  it("rejects a run in a killed child, warns once, restarts after 1 s and reopens from the source", async function () {
    this.timeout(START_DEADLINE_MS + 120_000);
    const { extensionPath } = await installedExtension();
    engine = await startEngine("postgres", `${process.pid}-${Date.now()}`, extensionPath);
    const connectionId = "e2e-postgres";
    const opened: ConnectionParams = {
      connection: engineFixture("postgres").connection(engine, connectionId),
      posture: { allowExternalFileAccess: false },
    };
    let reads = 0;
    // One revision throughout and no secretFields to ask again: the reopen this case counts is the restart's.
    const source: ConnectionSource = {
      read: async () => {
        reads += 1;
        return { params: opened, revision: 0, opened: () => Promise.resolve() };
      },
      reask: () => Promise.resolve(undefined),
      revision: () => 0,
    };
    const { deps, recording } = recordingDeps(extensionPath);
    supervisor = new BackendSupervisor(deps);
    const client = new BackendClient(supervisor, source, new OpenConnections());
    const loginStarted = Date.now();
    for (;;) {
      try {
        await client.testConnection(opened);
        break;
      } catch (error) {
        if (Date.now() - loginStarted > START_DEADLINE_MS) throw error;
      }
      await delay(1000);
    }

    await client.openConnection(opened);
    assert.equal(reads, 0);
    const run = client.runQuery({
      connectionId,
      queryId: randomUUID(),
      statement: "select pg_sleep(30)",
      limit: 500,
      offset: 0,
    });
    await delay(500);
    const restarted = nextState(supervisor, "starting");
    const killedAt = Date.now();
    process.kill(supervisor.pid as number, "SIGKILL");
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof BackendExitedError, String(error));
      assert.equal(error.exitCode, null);
      assert.equal(error.signal, "SIGKILL");
      return true;
    });
    assert.deepEqual(recording.warnings, [[CRASH_WARNING, "Show Log"]]);
    const gap = (await restarted) - killedAt;
    console.log(`the next child started ${gap} ms after the kill`);
    assert.ok(gap >= 1000 && gap < 4000, `${gap} ms`);
    assert.ok(Array.isArray(await client.listContainers({ connectionId })));
    assert.equal(reads, 1);
  });

  it("restarts after 1, 5 and 15 s, then fails with the error notification, whose Restart starts generation 5", async function () {
    this.timeout(120_000);
    const { deps, recording } = recordingDeps((await installedExtension()).extensionPath);
    const current = new BackendSupervisor(deps);
    supervisor = current;
    const kills: number[] = [];
    const startings: number[] = [];
    const failed = new Promise<void>((resolve) => {
      current.onDidChangeState((state) => {
        if (state === "starting") startings.push(Date.now());
        if (state === "ready" && kills.length < 4) {
          kills.push(Date.now());
          process.kill(current.pid as number, "SIGKILL");
        }
        if (state === "failed") resolve();
      });
    });
    void current.connection().catch(() => undefined);
    await failed;

    // startings[0] is the first start; startings[i + 1] follows kill i.
    const gaps = [1000, 5000, 15000].map((wait, index) => {
      const gap = startings[index + 1] - kills[index];
      assert.ok(gap >= wait && gap < wait + 3000, `restart ${index + 1} came ${gap} ms after its kill`);
      return gap;
    });
    console.log(`restarts ${gaps.join(", ")} ms after their kills`);
    assert.equal(kills.length, 4);
    assert.equal(current.state, "failed");
    assert.deepEqual(recording.errors, [[BUDGET_SPENT, "Show Log", "Restart"]]);

    const ready = nextState(current, "ready");
    recording.answerError("Restart");
    await ready;
    assert.equal(current.generation, 5);
  });
});
