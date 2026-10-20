import assert from "node:assert/strict";
import { type BackendProcess, NO_IPC_CHANNEL, startBackend } from "../../src/backend/start";

function fakeProcess(withIpc = true) {
  const sent: unknown[] = [];
  const exits: number[] = [];
  let onDisconnect: (() => void) | undefined;
  const proc: BackendProcess = {
    versions: { ...process.versions, electron: "43.7.7" } as NodeJS.ProcessVersions,
    ...(withIpc && { send: (message: unknown) => (sent.push(message), true) }),
    once: (_event, listener) => (onDisconnect = listener),
    exit: ((code: number) => {
      exits.push(code);
    }) as (code: number) => never,
  };
  return { proc, sent, exits, disconnect: () => onDisconnect?.() };
}

describe("startBackend", () => {
  it("answers its runtime's versions once, over the IPC channel", () => {
    const { proc, sent } = fakeProcess();
    startBackend(proc);
    assert.deepEqual(sent, [{ versions: proc.versions }]);
  });

  it("exits 0 when its host closes the channel, and not before", () => {
    const { proc, exits, disconnect } = fakeProcess();
    startBackend(proc);
    assert.deepEqual(exits, []);
    disconnect();
    assert.deepEqual(exits, [0]);
  });

  it("refuses to start without an IPC channel", () => {
    assert.throws(() => startBackend(fakeProcess(false).proc), { message: NO_IPC_CHANNEL });
  });
});

describe("the child entry", () => {
  it("starts the backend on its own process, which under Mocha has no IPC channel", async () => {
    await assert.rejects(import("../../src/backend/main"), { message: NO_IPC_CHANNEL });
  });
});
